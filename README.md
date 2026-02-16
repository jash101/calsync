# CalSync (Obsidian Plugin)

Reads todo items from your Obsidian notes and creates Google Calendar events with the correct duration.

## Requirements

- **Google account** — a Google account is required for full access.
- **Google Cloud project** — you must create a Google Cloud project with the Google Calendar API enabled and generate OAuth 2.0 credentials (Desktop app). See [Setup](#setup) below.
- **Desktop only** — this plugin uses a local HTTP server for OAuth and is not available on mobile.

## Network disclosure

This plugin connects to the following remote services:

| Service | Endpoint | Purpose |
|---------|----------|---------|
| Google OAuth 2.0 | `accounts.google.com`, `oauth2.googleapis.com` | Authenticate your Google account and obtain/refresh access tokens |
| Google Calendar API | `www.googleapis.com/calendar/v3` | Create, update, and delete calendar events corresponding to your todos |

No data is sent to any other service. The plugin communicates exclusively with Google's APIs using the credentials you provide.

## Todo format

```markdown
- [ ] Write blog post(2h)
- [ ] Team standup(30m)
- [ ] Deep work session(1h30m)
- [ ] Quick review(1.5h)
- [x] Done task(2h)(1h30m)     ← marked completed with time comparison
- [x] Done task(2h)            ← marked completed, actual time unavailable
```

- First parenthesis = **estimated time**
- Second parenthesis (optional) = **actual time required**
- Space before parentheses is optional

## How It Works

1. Run the command **"Sync todos from this file to GCal"** (or sync all files)
2. Incomplete todos get created as calendar events starting at 10:30 AM, stacked one after another
3. Completed todos (`[x]`) have their calendar event description updated to:
   ```
   Completed.
   Time Estimated: 2hrs
   Time Required: 1.5hrs
   Factor: 0.75
   ```
   If no actual time is provided, "Time Required" and "Factor" show as "unavailable".
4. If you edit a todo's text or duration and re-sync, the calendar event updates
5. If you remove a todo entirely, its event is cleaned up

## Setup

### 1. Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Go to **APIs & Services → Library** → search for **Google Calendar API** → Enable it
4. Go to **APIs & Services → Credentials** → **Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Desktop app**
   - No redirect URI needed — the plugin handles this automatically
5. Copy the **Client ID** and **Client Secret**

### 2. Install the Plugin

```bash
# Clone/copy this folder into your vault's plugin directory
cp -r obsidian-todo-gcal <your-vault>/.obsidian/plugins/todo-gcal-sync

# Install dependencies and build
cd <your-vault>/.obsidian/plugins/todo-gcal-sync
npm install
npm run build
```

### 3. Configure

1. Open Obsidian → Settings → Community Plugins → Enable "CalSync"
2. Go to the plugin settings
3. Paste your **Client ID** and **Client Secret**
4. Click **Authenticate** → authorize in your browser → the plugin captures the code automatically and completes setup.
5. Adjust start time if needed (default: 10:30 AM)

### 4. Use It

- Open a file with todos
- Open command palette (`Cmd/Ctrl + P`)
- Run **"Sync todos from this file to GCal"**

## Commands

| Command | Description |
|---------|-------------|
| `Sync todos from this file to GCal` | Syncs todos in the currently active file |
| `Sync all todos to GCal` | Syncs todos across every `.md` file in the vault |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Start hour | 10 | Events start from this hour (24h) |
| Start minute | 30 | Events start from this minute |
| Calendar ID | primary | Which Google Calendar to use |
| Time zone | Auto-detected | IANA timezone string |

## How Conflict Handling Works

- Each todo is tracked by a hash of its file path, text, and duration
- On re-sync: changed todos → update the event; removed todos → delete the event; completed todos → update description with time comparison
- Sync state is stored in `.obsidian/plugins/todo-gcal-sync/sync-data.json`
