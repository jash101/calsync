import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  requestUrl,
} from "obsidian";

import * as http from "http";

// ─── Types ──────────────────────────────────────────────────────────────────

interface TodoItem {
  text: string;
  rawLine: string;
  durationMinutes: number;   // estimated duration (first parenthesis)
  actualMinutes: number | null; // actual duration (second parenthesis, only for completed)
  lineNumber: number;
  completed: boolean;
  hash: string; // deterministic hash for tracking edits
}

interface SyncRecord {
  hash: string;
  googleEventId: string;
  filePath: string;
  lineNumber: number;
  todoText: string;
  durationMinutes: number;
  lastSynced: string;
}

interface SyncData {
  records: SyncRecord[];
}

interface PluginSettings {
  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string;
  googleAccessToken: string;
  tokenExpiry: number;
  calendarId: string;
  startHour: number;
  startMinute: number;
  timeZone: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
  googleClientId: "",
  googleClientSecret: "",
  googleRefreshToken: "",
  googleAccessToken: "",
  tokenExpiry: 0,
  calendarId: "primary",
  startHour: 10,
  startMinute: 30,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

// ─── Utility: Simple hash ───────────────────────────────────────────────────

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// ─── Todo Parser ────────────────────────────────────────────────────────────

/** Parse a duration group like "2h", "30m", "1h30m", "1.5h" into minutes. */
function parseDuration(hoursStr: string | undefined, minutesStr: string | undefined): number {
  let total = 0;
  if (hoursStr) total += parseFloat(hoursStr.replace("h", "")) * 60;
  if (minutesStr) total += parseInt(minutesStr.replace("m", ""));
  return total;
}

function parseTodos(content: string, filePath: string): TodoItem[] {
  const lines = content.split("\n");
  const todos: TodoItem[] = [];

  // Matches: - [ ] Task text(1h30m) or (2h) or (45m) or (1.5h)
  //   — no space required before parentheses
  //   — optional second duration for actual time: (estimated)(actual)
  const todoRegex =
    /^[\s]*- \[([ xX])\]\s+(.+?)\s*\((\d+(?:\.\d+)?h)?(\d+m)?\)\s*(?:\((\d+(?:\.\d+)?h)?(\d+m)?\))?\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(todoRegex);
    if (!match) continue;

    const completed = match[1] !== " ";
    const text = match[2].trim();

    // First parenthesis = estimated duration
    const estimatedMinutes = parseDuration(match[3], match[4]);
    if (estimatedMinutes === 0) continue;

    // Second parenthesis = actual duration (only meaningful for completed items)
    const hasActual = match[5] !== undefined || match[6] !== undefined;
    const actualMinutes = hasActual ? parseDuration(match[5], match[6]) : null;

    // Hash based on text + estimated duration
    const hash = simpleHash(`${filePath}::${text}::${estimatedMinutes}`);

    todos.push({
      text,
      rawLine: line,
      durationMinutes: estimatedMinutes,
      actualMinutes,
      lineNumber: i,
      completed,
      hash,
    });
  }

  return todos;
}

// ─── Google Calendar Service ────────────────────────────────────────────────

class GoogleCalendarService {
  private plugin: TodoGCalPlugin;

  constructor(plugin: TodoGCalPlugin) {
    this.plugin = plugin;
  }

  private get settings(): PluginSettings {
    return this.plugin.settings;
  }

  async ensureAccessToken(): Promise<string> {
    // If token is still valid (with 60s buffer), reuse it
    if (
      this.settings.googleAccessToken &&
      Date.now() < this.settings.tokenExpiry - 60000
    ) {
      return this.settings.googleAccessToken;
    }

    if (!this.settings.googleRefreshToken) {
      throw new Error(
        "No refresh token. Please authenticate in plugin settings."
      );
    }

    const response = await requestUrl({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: [
        `client_id=${encodeURIComponent(this.settings.googleClientId)}`,
        `client_secret=${encodeURIComponent(this.settings.googleClientSecret)}`,
        `refresh_token=${encodeURIComponent(this.settings.googleRefreshToken)}`,
        `grant_type=refresh_token`,
      ].join("&"),
    });

    const data = response.json;
    this.settings.googleAccessToken = data.access_token;
    this.settings.tokenExpiry = Date.now() + data.expires_in * 1000;
    await this.plugin.saveSettings();

    return data.access_token;
  }

  async createEvent(
    summary: string,
    startTime: Date,
    durationMinutes: number
  ): Promise<string> {
    const token = await this.ensureAccessToken();
    const endTime = new Date(
      startTime.getTime() + durationMinutes * 60 * 1000
    );

    const event = {
      summary,
      start: {
        dateTime: startTime.toISOString(),
        timeZone: this.settings.timeZone,
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: this.settings.timeZone,
      },
    };

    const calId = encodeURIComponent(this.settings.calendarId || "primary");
    const response = await requestUrl({
      url: `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });

    return response.json.id;
  }

  async updateEvent(
    eventId: string,
    summary: string,
    startTime: Date,
    durationMinutes: number
  ): Promise<void> {
    const token = await this.ensureAccessToken();
    const endTime = new Date(
      startTime.getTime() + durationMinutes * 60 * 1000
    );

    const event = {
      summary,
      start: {
        dateTime: startTime.toISOString(),
        timeZone: this.settings.timeZone,
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: this.settings.timeZone,
      },
    };

    const calId = encodeURIComponent(this.settings.calendarId || "primary");
    await requestUrl({
      url: `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${eventId}`,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });
  }

  async markEventCompleted(
    eventId: string,
    estimatedMinutes: number,
    actualMinutes: number | null
  ): Promise<void> {
    const token = await this.ensureAccessToken();
    const calId = encodeURIComponent(this.settings.calendarId || "primary");

    const estHours = (estimatedMinutes / 60).toFixed(2).replace(/\.?0+$/, "");
    let description: string;

    if (actualMinutes !== null && actualMinutes > 0) {
      const actHours = (actualMinutes / 60).toFixed(2).replace(/\.?0+$/, "");
      const factor = (actualMinutes / estimatedMinutes).toFixed(2).replace(/\.?0+$/, "");
      description =
        `Completed.\n` +
        `Time Estimated: ${estHours}hrs\n` +
        `Time Required: ${actHours}hrs\n` +
        `Factor: ${factor}`;
    } else {
      description =
        `Completed.\n` +
        `Time Estimated: ${estHours}hrs\n` +
        `Time Required: unavailable\n` +
        `Factor: unavailable`;
    }

    await requestUrl({
      url: `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${eventId}`,
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description }),
    });
  }

  async deleteEvent(eventId: string): Promise<void> {
    const token = await this.ensureAccessToken();
    const calId = encodeURIComponent(this.settings.calendarId || "primary");

    try {
      await requestUrl({
        url: `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${eventId}`,
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (e) {
      // Event may already be deleted — that's fine
      console.log("Event delete failed (may already be gone):", e);
    }
  }
}

// ─── OAuth Helper: Local loopback server ────────────────────────────────────
// Google deprecated OOB (urn:ietf:wg:oauth:2.0:oob). Desktop app clients
// automatically allow loopback redirects (http://127.0.0.1:PORT/) without
// needing to register the URI in the console.

function startLocalOAuthServer(): Promise<{
  port: number;
  codePromise: Promise<string>;
  cleanup: () => void;
}> {
  return new Promise((resolveSetup, rejectSetup) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", `http://127.0.0.1`);
      const code = reqUrl.searchParams.get("code");
      const error = reqUrl.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

      if (error) {
        res.end(
          "<html><body style='font-family:sans-serif;text-align:center;padding:40px'>" +
            "<h1>Authentication Failed</h1>" +
            `<p>Error: ${error}</p>` +
            "<p>You can close this tab and try again in Obsidian.</p>" +
            "</body></html>"
        );
        server.close();
        rejectCode(new Error(`Google OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.end(
          "<html><body style='font-family:sans-serif;text-align:center;padding:40px'>" +
            "<h1>Authenticated!</h1>" +
            "<p>You can close this tab and return to Obsidian.</p>" +
            "</body></html>"
        );
        server.close();
        resolveCode(code);
        return;
      }

      // Unrecognised request (e.g. favicon)
      res.end("");
    });

    server.on("error", (err) => {
      rejectSetup(err);
    });

    // Listen on port 0 → OS picks a random available port
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        rejectSetup(new Error("Failed to get server address"));
        return;
      }

      // Auto-close after 5 minutes if no response
      const timeout = setTimeout(() => {
        server.close();
        rejectCode(new Error("OAuth timed out — no response within 5 minutes."));
      }, 5 * 60 * 1000);

      const cleanup = () => {
        clearTimeout(timeout);
        server.close();
      };

      resolveSetup({ port: addr.port, codePromise, cleanup });
    });
  });
}

// ─── Main Plugin ────────────────────────────────────────────────────────────

export default class TodoGCalPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  syncData: SyncData = { records: [] };
  gcal: GoogleCalendarService = new GoogleCalendarService(this);

  async onload() {
    await this.loadSettings();
    await this.loadSyncData();

    this.gcal = new GoogleCalendarService(this);

    // Register the main sync command
    this.addCommand({
      id: "sync-todos-to-gcal",
      name: "File",
      callback: () => this.syncCurrentFile(),
    });

    // Register command to sync all files
    this.addCommand({
      id: "sync-all-todos-to-gcal",
      name: "All",
      callback: () => this.syncAllFiles(),
    });

    // Settings tab
    this.addSettingTab(new TodoGCalSettingTab(this.app, this));

    console.log("CalSync plugin loaded");
  }

  async onunload() {
    console.log("CalSync plugin unloaded");
  }

  // ── Settings persistence ───────────────────────────────────────────────

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── Sync data persistence (stored in plugin folder) ────────────────────

  private getSyncDataPath(): string {
    return `${this.manifest.dir}/sync-data.json`;
  }

  async loadSyncData() {
    try {
      const adapter = this.app.vault.adapter;
      const path = this.getSyncDataPath();
      if (await adapter.exists(path)) {
        const raw = await adapter.read(path);
        this.syncData = JSON.parse(raw);
      }
    } catch (e) {
      console.error("Failed to load sync data:", e);
      this.syncData = { records: [] };
    }
  }

  async saveSyncData() {
    try {
      const adapter = this.app.vault.adapter;
      await adapter.write(
        this.getSyncDataPath(),
        JSON.stringify(this.syncData, null, 2)
      );
    } catch (e) {
      console.error("Failed to save sync data:", e);
    }
  }

  // ── Core sync logic ────────────────────────────────────────────────────

  async syncCurrentFile() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active file to sync.");
      return;
    }
    new Notice("Syncing...");
    await this.syncFile(activeFile);
  }

  async syncAllFiles() {
    new Notice("Syncing all files...");
    const files = this.app.vault.getMarkdownFiles();
    let totalSynced = 0;

    for (const file of files) {
      const content = await this.app.vault.read(file);
      const todos = parseTodos(content, file.path);
      if (todos.length > 0) {
        totalSynced += await this.syncTodos(todos, file.path);
      }
    }

    new Notice(`Synced ${totalSynced} todos across all files.`);
  }

  async syncFile(file: TFile) {
    if (!this.settings.googleClientId || !this.settings.googleRefreshToken) {
      new Notice(
        "Google Calendar not configured. Go to plugin settings to authenticate."
      );
      return;
    }

    const content = await this.app.vault.read(file);
    const todos = parseTodos(content, file.path);

    if (todos.length === 0) {
      new Notice("No todos with duration found in this file.");
      return;
    }

    const synced = await this.syncTodos(todos, file.path);
    new Notice(`Synced ${synced} todos to Google Calendar.`);
  }

  async syncTodos(todos: TodoItem[], filePath: string): Promise<number> {
    // Build the start time: today at configured start time
    const now = new Date();
    let cursor = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      this.settings.startHour,
      this.settings.startMinute,
      0
    );

    let syncedCount = 0;

    // Get existing records for this file
    const existingRecords = this.syncData.records.filter(
      (r) => r.filePath === filePath
    );

    // Track which records are still relevant
    const activeHashes = new Set<string>();

    for (const todo of todos) {
      // Completed todos → update event description with completion info
      if (todo.completed) {
        const existing = existingRecords.find((r) => r.hash === todo.hash);
        if (existing) {
          try {
            await this.gcal.markEventCompleted(
              existing.googleEventId,
              todo.durationMinutes,
              todo.actualMinutes
            );
            // Keep the record but mark it so we don't re-process
            activeHashes.add(todo.hash);
          } catch (e) {
            console.error("Failed to mark event completed:", e);
          }
        }
        syncedCount++;
        continue;
      }

      activeHashes.add(todo.hash);

      const existingRecord = existingRecords.find(
        (r) => r.hash === todo.hash
      );

      try {
        if (existingRecord) {
          // UPDATE existing event
          // Check if anything changed (text or duration)
          if (
            existingRecord.todoText !== todo.text ||
            existingRecord.durationMinutes !== todo.durationMinutes
          ) {
            await this.gcal.updateEvent(
              existingRecord.googleEventId,
              todo.text,
              cursor,
              todo.durationMinutes
            );

            existingRecord.todoText = todo.text;
            existingRecord.durationMinutes = todo.durationMinutes;
            existingRecord.lineNumber = todo.lineNumber;
            existingRecord.lastSynced = new Date().toISOString();
          }
          // Even if unchanged, still advance the cursor
        } else {
          // CREATE new event
          const eventId = await this.gcal.createEvent(
            todo.text,
            cursor,
            todo.durationMinutes
          );

          this.syncData.records.push({
            hash: todo.hash,
            googleEventId: eventId,
            filePath,
            lineNumber: todo.lineNumber,
            todoText: todo.text,
            durationMinutes: todo.durationMinutes,
            lastSynced: new Date().toISOString(),
          });
        }

        syncedCount++;
      } catch (e) {
        console.error(`Failed to sync todo "${todo.text}":`, e);
        new Notice(`Failed to sync: ${todo.text}. Check console for details.`);
      }

      // Advance cursor by this todo's duration
      cursor = new Date(
        cursor.getTime() + todo.durationMinutes * 60 * 1000
      );
    }

    // Clean up records for todos that no longer exist in the file
    const orphanedRecords = existingRecords.filter(
      (r) => !activeHashes.has(r.hash)
    );
    for (const orphan of orphanedRecords) {
      try {
        await this.gcal.deleteEvent(orphan.googleEventId);
      } catch (e) {
        console.error("Failed to delete orphaned event:", e);
      }
      this.syncData.records = this.syncData.records.filter(
        (r) => r.hash !== orphan.hash
      );
    }

    await this.saveSyncData();
    return syncedCount;
  }
}

// ─── Settings Tab ───────────────────────────────────────────────────────────

class TodoGCalSettingTab extends PluginSettingTab {
  plugin: TodoGCalPlugin;

  constructor(app: App, plugin: TodoGCalPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "CalSync" });

    // ── Google OAuth Setup ─────────────────────────────────────────────

    containerEl.createEl("h3", { text: "Google Calendar Authentication" });

    containerEl.createEl("p", {
      text: 'Go to Google Cloud Console → Create a project → Enable Google Calendar API → Create OAuth 2.0 credentials (Desktop app). No redirect URI setup needed.',
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Google Client ID")
      .setDesc("OAuth 2.0 Client ID from Google Cloud Console")
      .addText((text) =>
        text
          .setPlaceholder("xxxx.apps.googleusercontent.com")
          .setValue(this.plugin.settings.googleClientId)
          .onChange(async (value) => {
            this.plugin.settings.googleClientId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Google Client Secret")
      .setDesc("OAuth 2.0 Client Secret")
      .addText((text) =>
        text
          .setPlaceholder("GOCSPX-xxxx")
          .setValue(this.plugin.settings.googleClientSecret)
          .onChange(async (value) => {
            this.plugin.settings.googleClientSecret = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Authenticate with Google")
      .setDesc(
        this.plugin.settings.googleRefreshToken
          ? "✅ Authenticated — you can re-authenticate if needed."
          : "⚠️ Not yet authenticated. Click to begin."
      )
      .addButton((btn) =>
        btn.setButtonText("Authenticate").onClick(async () => {
          await this.startOAuthFlow();
        })
      );

    // ── Scheduling Config ──────────────────────────────────────────────

    containerEl.createEl("h3", { text: "Scheduling" });

    new Setting(containerEl)
      .setName("Start time (hour)")
      .setDesc("Events start stacking from this hour (24h format)")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.startHour))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num >= 0 && num <= 23) {
              this.plugin.settings.startHour = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Start time (minute)")
      .setDesc("Events start stacking from this minute")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.startMinute))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num >= 0 && num <= 59) {
              this.plugin.settings.startMinute = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Time zone")
      .setDesc("IANA time zone (auto-detected)")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.timeZone)
          .onChange(async (value) => {
            this.plugin.settings.timeZone = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Calendar ID")
      .setDesc('Use "primary" for your default calendar, or paste a specific calendar ID')
      .addText((text) =>
        text
          .setPlaceholder("primary")
          .setValue(this.plugin.settings.calendarId)
          .onChange(async (value) => {
            this.plugin.settings.calendarId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── Usage Info ─────────────────────────────────────────────────────

    containerEl.createEl("h3", { text: "Usage" });

    const usageDiv = containerEl.createDiv();
    usageDiv.innerHTML = `
      <p><strong>Todo format:</strong></p>
      <pre style="background: var(--background-secondary); padding: 10px; border-radius: 5px;">
- [ ] Write blog post(2h)
- [ ] Team standup(30m)
- [ ] Deep work session(1h30m)
- [ ] Quick review(1.5h)
- [x] Completed task(2h)(1h30m)  ← marked completed with time comparison
- [x] Completed task(2h)         ← marked completed, actual time unavailable</pre>
      <p><strong>Completed todos:</strong> The first parenthesis is the estimated time, the optional second parenthesis is the actual time required. The calendar event description is updated with a comparison.</p>
      <p><strong>Commands:</strong></p>
      <ul>
        <li><code>CalSync: File</code> — syncs the current file</li>
        <li><code>CalSync: All</code> — syncs every .md file in your vault</li>
      </ul>
      <p>Events stack starting at ${this.plugin.settings.startHour}:${String(this.plugin.settings.startMinute).padStart(2, "0")} today. Editing a todo's text or duration will update the calendar event on next sync.</p>
    `;
  }

  async startOAuthFlow() {
    const clientId = this.plugin.settings.googleClientId;
    const clientSecret = this.plugin.settings.googleClientSecret;

    if (!clientId || !clientSecret) {
      new Notice("Please fill in Client ID and Client Secret first.");
      return;
    }

    // Start a temporary local server to capture the OAuth redirect.
    // Desktop app clients automatically allow loopback redirects — no
    // need to register the URI in the Google Cloud Console.
    let port: number;
    let codePromise: Promise<string>;
    let cleanup: () => void;

    try {
      ({ port, codePromise, cleanup } = await startLocalOAuthServer());
    } catch (e) {
      console.error("Failed to start local OAuth server:", e);
      new Notice("❌ Could not start local auth server. Check console.");
      return;
    }

    const redirectUri = `http://127.0.0.1:${port}/`;
    const scope = "https://www.googleapis.com/auth/calendar.events";
    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scope)}` +
      `&access_type=offline` +
      `&prompt=consent`;

    // Open browser for user to sign in
    new Notice("Opening browser for Google sign-in…");
    window.open(authUrl);

    // Wait for Google to redirect back to our local server with the code
    let code: string;
    try {
      code = await codePromise;
    } catch (e) {
      cleanup();
      console.error("OAuth code capture failed:", e);
      new Notice(`❌ Authentication failed: ${(e as Error).message}`);
      return;
    }

    // Exchange code for tokens
    try {
      const response = await requestUrl({
        url: "https://oauth2.googleapis.com/token",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: [
          `code=${encodeURIComponent(code)}`,
          `client_id=${encodeURIComponent(clientId)}`,
          `client_secret=${encodeURIComponent(clientSecret)}`,
          `redirect_uri=${encodeURIComponent(redirectUri)}`,
          `grant_type=authorization_code`,
        ].join("&"),
      });

      const data = response.json;
      this.plugin.settings.googleAccessToken = data.access_token;
      this.plugin.settings.googleRefreshToken = data.refresh_token;
      this.plugin.settings.tokenExpiry =
        Date.now() + data.expires_in * 1000;
      await this.plugin.saveSettings();

      new Notice("✅ Google Calendar authenticated successfully!");
      this.display(); // Refresh the settings UI
    } catch (e) {
      console.error("OAuth token exchange failed:", e);
      new Notice("❌ Authentication failed. Check console for details.");
    }
  }
}
