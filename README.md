# Todos

A Mac app for a todo list shared between you and your Claude sessions. You manage tasks in the app. Claude Code and Cowork sessions read and update the same list through an MCP server bundled inside the app. Changes from any session show up in the window immediately.

```
electron/main.js     app shell: window, menus, Dock badge, menu bar item, quick capture, reminders
electron/capture-preload.cjs   bridge for the quick-capture panel
electron/handoff.js  "Start with Claude": chooses the folder and opens a Claude session on a task
electron/pairing.js  the "Pair iPhone" window
electron/cli-install.js  "Install Command Line Tool": the link to the `todos` command inside the app
src/quickadd.js      one-line entry parser ("Renew passport fri !high #personal")
public/              dashboard UI (vanilla HTML/CSS/JS); markdown.js renders notes safely
src/store.js         shared JSON store with file locking (safe for many concurrent sessions)
src/server.js        dashboard server (REST API + live updates); embedded in the app or run via `npm start`
src/api-v1.js        /api/v1, the API for your other devices and the `todos` command (see docs/openapi.json)
src/socket.js        the local socket the `todos` command uses on this Mac
src/claude-session.js  what a "Start with Claude" session is started with, for the app's button and the command
src/auth.js          access token, session cookies, rate limits
src/remote.js        remote-access state shared by the app and the server
src/tailscale.js     reads Tailscale's state; sets up and removes the `tailscale serve` mapping
src/pairing.js       what the "Pair iPhone" QR code says, and the page that shows it
src/qr.js            QR code generator (no dependencies)
src/mcp.js           MCP server (stdio) that Claude launches
build/icon.png       app icon (regenerate with `npm run icon`)
scripts/build-cli.js builds the `todos` command into the app (part of `npm run dist`)
docs/openapi.json    API reference
docs/SECURITY.md     what remote access and the local socket protect, and what they don't
test/                `npm test` (Node's built-in runner, no dependencies); test/app/ runs the real app (`npm run test:app`)
cli/                 the `todos` command-line client (Go)
ios/                 the iPhone app (see ios/README.md)
```

## Install

Open `dist/Todos-<version>-arm64.dmg` and drag **Todos** to Applications.

The build is ad-hoc signed, not notarized. It opens normally on the Mac that built it. On another Mac, right-click the app and choose **Open** the first time.

## Quick capture

Press **⌃⌥T** (Control-Option-T) in any app to open a small capture box. Type one line and press Enter. The box shows what it understood as you type, then gets out of the way: the app you were in stays in front.

| You type | What happens |
| --- | --- |
| `today`, `tomorrow`, `fri`, `next friday`, `next week`, `in 3 days`, `oct 20`, `2026-10-20` | Sets the due date |
| `3pm`, `9:30am`, `15:00`, `noon` | Sets a reminder at that time, due that day (today, or tomorrow if the time has passed) |
| `every day`, `every weekday`, `every week`, `every 2 weeks`, `every month`, `every year`, `every friday` | Makes it repeat |
| `!high`, `!med`, `!low` | Priority |
| `#name` | Project |
| `@name` | Tag (`@claude` assigns the task to Claude) |

For example: `Renew passport fri !high #personal`, `Call dentist tomorrow 3pm`, `Water plants every day`.

- Dates, times and repeats are picked up anywhere in the line. The `!`, `#` and `@` markers only count at the start or end of the line, so "Reply to @sam about PR #42" keeps its title.
- To keep a word literal, put a backslash in front of it: `Watch \tomorrow never dies`.
- **Enter** adds the task and closes. **⌘Enter** adds it and stays open for another. **Esc** closes.
- The same one-line entry works in the add bar at the top of the dashboard.
- Change or turn off the shortcut under **Todos → Quick Capture Shortcut**. If another app already uses the keys, the menu says so.
- Other launchers can open the box with `open -a Todos --args --capture`.

## Hand off to Claude

Open a task and click **Start with Claude** to open a Claude Code session on it.

1. The first time for a project, you choose the folder Claude should work in. The app remembers it per project (**Change folder…** picks a different one). Tasks with no project ask each time.
2. The session opens where the switch next to the button says:
   - **in the Claude app** (default): opens the desktop app's Code tab with the folder and the prompt filled in. Nothing runs until you check it and press Enter. The app asks you to confirm the folder.
   - **in Terminal**: starts an interactive `claude` session in that folder straight away. Claude asks before acting, as usual; only the todo tools are pre-approved. If the `claude` command isn't logged in, run `/login` there once.
3. The task is assigned to Claude and a note is added to its activity.

The prompt tells Claude to read the task with the todo tools, mark it in progress, check off subtasks, comment on progress, mark it done when finished, and mark it blocked with a comment if it needs something from you.

**Notifications.** You get a Mac notification when a Claude session comments on a task, finishes it, or marks it blocked (from any session, not only ones started here). Click it to open the task. They're skipped while the Todos window is in front, since the card flashes there. Turn them off with **Todos → Notify About Claude's Updates**.

The app looks for the `claude` command in `~/.local/bin`, Homebrew's folders, and the Claude desktop app's own copy. Set `TODOS_CLAUDE_BIN` to use a specific one.

The `todos` command can start a session on a task from a terminal on the Mac. It asks the app for exactly what the button would use (the same prompt, the folder remembered for the project, the same options for `claude`) and runs `claude` itself, in the terminal you are in. The task is assigned to Claude and its activity says "Started with Claude from terminal". This only works on the Mac itself, not from another machine.

## Using Todos from your other devices

Todos can be opened from your phone or another computer on your Tailscale tailnet. The Mac stays the only copy of your list: other devices talk to it, they don't sync.

This is off by default. While it's off, nothing here applies and the app behaves as it always has.

### Turn it on

1. On the Mac, choose **Todos → Remote Access → Allow Access from My Other Devices**.
2. The app offers to set up Tailscale Serve. It shows the one command it will run (`tailscale serve --bg --https=443 http://127.0.0.1:7420`) and runs it only if you click **Set Up**. You can also do this later with **Remote Access → Set Up Tailscale Serve…**, or run the command yourself.
3. The menu then shows the address, for example `On at your-mac.your-tailnet.ts.net`. **Copy Address** copies it.

Requirements: Tailscale running on the Mac, and HTTPS certificates enabled for your tailnet (Tailscale admin console → DNS → HTTPS Certificates). If something's missing, the status line in the menu says what.

### Sign in from a phone or another computer

1. Make sure Tailscale is connected on that device.
2. Open the address in a browser. You'll get a sign-in page.
3. On the Mac, choose **Remote Access → Copy Access Token**, and enter it on the device (a password manager can hold it). You stay signed in on that device for 90 days.
4. On a phone, use the browser's **Add to Home Screen** to get an app icon. The home-screen app has its own sign-in, so enter the token there once too.

Everything works as it does on the Mac, including live updates, except **Start with Claude**, which only exists in the app on the Mac itself. Changes you make from another device show in a task's activity as "You · iPhone" (the device name comes from Tailscale).

If you edit something on a device whose copy is out of date (for example a Claude session changed the task while your phone was offline), the edit is refused and the page shows the latest version instead of overwriting it.

### The iPhone app

There is a native iPhone app in `ios/`. `ios/README.md` covers building and installing it. It needs Todos 1.6 or later on the Mac.

To connect it, choose **Remote Access → Pair iPhone…** on the Mac and scan the code with the app. The code holds the address and the access token, so the window shows it for a minute only and is left out of screenshots and screen sharing. You can also type the address and token into the app instead.

### Add tasks from an iOS Shortcut

With the iPhone app installed, use its own **Add Task** action in Shortcuts instead (see `ios/README.md`): it needs no token in the shortcut and also works when the Mac can't be reached. The steps below are for a shortcut that talks to the Mac directly, without the app.

The quick-capture endpoint takes one line, read exactly as ⌃⌥T reads it.

1. In Shortcuts, create a shortcut with **Ask for Input** (Text, prompt "New task"). Use **Dictate Text** instead if you'd rather speak it.
2. Add **Get Contents of URL**:
   - URL: `https://your-mac.your-tailnet.ts.net/api/v1/capture`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer ` followed by your access token; `X-Todos-Client` = `iOS Shortcut`
   - Request Body: **JSON**, with one field `text` set to the **Provided Input**
3. Optionally add **Get Dictionary Value** for `task.title` and **Show Notification**, to confirm what was added.

Then "Renew passport fri !high #personal" becomes a task due Friday, high priority, in project personal.

The same from a terminal on another machine:

```bash
curl -sS https://your-mac.your-tailnet.ts.net/api/v1/capture \
  -H "Authorization: Bearer $TODOS_TOKEN" -H "Content-Type: text/plain" \
  -d "Call dentist tomorrow 3pm"
```

### The API

`docs/openapi.json` documents every endpoint under `/api/v1`: tasks (list, filter, search, create, edit, complete, delete), subtasks, comments, history, quick capture, what's due, the daily summary, and live updates. Send the access token as `Authorization: Bearer …`.

`GET /api/v1/meta` says which API version and revision the app speaks. Within version 1 things are only added, and each addition raises the revision, so a client can check for "version 1, revision N or later" before relying on something newer. Todos 1.4 has no `/meta` (revision 1); 1.5 is revision 2; 1.6 is revision 3; the release with the `todos` command is revision 4 (`/info`, and the API on the local socket).

Any change can carry an `Idempotency-Key` header (8 to 64 letters, digits, hyphens or underscores; a UUID works). Sending the same change again with the same key does nothing the second time and answers with the task as it is now, so a script or app can retry after a timeout without adding a task twice. `/capture` also takes an optional `at`, the moment a line was typed, for lines that reach the Mac later: "tomorrow" is then read from that moment.

Edits and deletes must say which revision of the task they are based on (`If-Match: "3"`, from the task's `rev` or the `ETag` header). If the task has changed since, you get `409` with the current task and nothing is overwritten. Adding comments, adding or checking subtasks, and completing a task need no revision.

At the network address and on port 7420, the API only exists while remote access is on, and always needs the token, including from scripts on the Mac itself. On the Mac's local socket (see [The `todos` command](#the-todos-command)) it is always there and needs no token. A few routes exist only on the socket: the ones behind `todos` starting a Claude session.

### Managing access

- **Rotate Access Token…** signs out every other device and script at once. Use it if a device is lost. (Signing out on a device only clears that device's cookie.)
- **Only My Tailscale Account** (on by default) refuses devices signed in to Tailscale as anyone else, even with the token. Turn it off if you share the list with another account or use tagged devices.
- Turning the setting off stops answering other devices immediately. The Tailscale Serve mapping stays until you choose **Remove Tailscale Serve Mapping…**, but it leads nowhere while the setting is off.
- `docs/SECURITY.md` describes what is and isn't protected.

### Keeping the Mac reachable

Other devices can only reach Todos while the app is running and the Mac is awake and on Tailscale. Turn on **Todos → Launch at Login**, let Tailscale start at login, and keep the Mac from sleeping (System Settings → Energy; a display that sleeps is fine). When the Mac can't be reached, the page shows "Offline" and reconnects by itself; scripts and Shortcuts should treat a timeout as "try again later".

## The `todos` command

The app carries a command-line client, `todos`, inside its bundle (`Todos.app/Contents/Resources/bin/todos`).

### Install it

Choose **Todos → Install Command Line Tool**. This links `~/.local/bin/todos` to the copy inside the app, so the command is always the one that came with the app you have installed. It needs no password. If `~/.local/bin` isn't on your PATH, the app says so and shows the one line to add; it never edits your shell's files itself. **Uninstall Command Line Tool** removes the link. Neither will touch a `todos` that something else put there. If you move the app, choose Install again.

### On this Mac

The command talks to the running app through a local socket, `~/Library/Application Support/Todos/todos.sock`, which only your user can open. It needs no access token and works whether or not remote access is on. (A socket's path can be at most 103 bytes. If your home folder's path is long enough to push it past that, the socket goes to `~/.todos/todos.sock` instead.)

If the app isn't running, the command can start it for you, with:

```bash
open -g -a Todos --args --background
```

Started this way, the server, the menu bar item, reminders and notifications all run, but no window opens and whatever app you were in stays in front. If the app is already running, nothing visible happens. Opening Todos in the usual way afterwards shows its window.

### From another machine

On a machine that only has the command, it reaches the Mac the way your phone does: remote access on, the address from **Remote Access → Copy Address**, and the access token from **Copy Access Token**. Everything works except starting a Claude session, which only exists on the Mac.

The command may also start the app on the Mac over SSH (`ssh your-mac open -g -a Todos --args --background`). macOS only lets that work **while you are logged in to the Mac's desktop**: a Mac sitting at the login window, or one you have logged out of, has nowhere to open an app, and `open` fails. For a Mac you want reachable after a restart, log in automatically and turn on **Todos → Launch at Login**.

### Is the app there?

`GET /health` answers `{"status":"ok","appVersion":"…","apiVersion":{"version":1,"revision":4}}` as soon as the server is ready, on the socket and on the port, with no sign-in. It says nothing about your list. `GET /api/v1/info` adds `minClientVersions`, the oldest version of each client (`cli`, `ios`) that still works with this app.

```bash
curl --unix-socket ~/Library/Application\ Support/Todos/todos.sock http://todos/health
```

## Menu bar

The check icon in the menu bar shows how many tasks are overdue or due today. Click it to see what's overdue, due today, coming in the next 7 days, and undated, and click a task to open it. **New Task…** opens quick capture. Hide the icon with **Todos → Show in Menu Bar**.

## Using the app

- **Stat tiles** (Open, Due today, Overdue, With Claude, Done this week) double as filters. Click one to focus on it.
- **Add bar**: press `⌘N` or `N` and type a task. One-line entry works here too (`Renew passport fri !high #personal`), or pick a project, priority, or due date with the controls. Press Enter to add it.
- **Board**: drag cards between To do, In progress, Blocked, and Done, or click the circle to complete a task.
- **Details**: click a card to edit its title, status, priority, assignee, due date, project, tags, and notes. You can also read the activity log and leave comments.
- **Subtasks**: add a checklist to any task in its details. The card shows progress (for example 2/5), and Claude can add and check off subtasks too.
- **Markdown notes**: notes render as Markdown (headings, bold, lists, task lists, code, quotes) with clickable links. Click the notes or **Edit** to change them. Links in comments are clickable too.
- **Repeating tasks**: set **Repeat** to daily, every weekday, weekly, every 2 weeks, monthly, or yearly. Completing the task creates the next occurrence with the next due date and a fresh checklist. The finished one stays in Done as history.
- **Reminders**: set **Remind me** to a date and time to get a Mac notification then. If you get your reminders on the iPhone app instead, turn off **Todos → Reminder Notifications on This Mac** so you aren't reminded twice; the reminder still shows in the Todos window. Click the notification to open the task. Reminders missed while the app was closed arrive when it next opens. Reminders only fire while the app is running, so turn on **Launch at Login** if you rely on them.
- **Daily summary**: at 9 AM (or when the app first opens after that) you get one notification listing what's due today and overdue. Turn it off with **Todos → Daily Summary at 9 AM**.
- **Search**: press `⌘F` or `/`. Press `Esc` to close panels.
- **Live changes**: cards that Claude changes flash briefly. The activity log shows which session made each change, for example "Claude Code · my-repo" or "Cowork".
- **Dock badge**: shows how many tasks are overdue or due today.
- **App menu**:
  - **Todos → Launch at Login**
  - **Todos → Reminder Notifications on This Mac**
  - **Todos → Daily Summary at 9 AM**
  - **Todos → Send Test Notification**: use this to check that macOS is allowing notifications from Todos. If nothing appears, allow them in System Settings → Notifications → Todos. Reminders also show as a banner inside the app window either way.
  - **Todos → Install Command Line Tool** and **Uninstall Command Line Tool**: see [The `todos` command](#the-todos-command).
  - **File → Open in Browser**: the dashboard is also at http://127.0.0.1:7420 while the app runs.
  - **File → Show Data File in Finder**
  - **File → Copy Claude Code Setup Command**

Closing the window keeps the app running in the Dock (normal Mac behavior), so the badge stays current. Quit with `⌘Q`. Claude can read and update your todos even when the app isn't running. The app just shows the changes the next time you open it.

## Connecting Claude

The MCP server ships inside the app and runs on the app's own runtime, so you don't need a separate Node install. Setting `ELECTRON_RUN_AS_NODE=1` runs the app binary as plain Node with no window or Dock icon.

**Claude Code** (all projects). **File → Copy Claude Code Setup Command** in the app copies this command:

```bash
claude mcp add todolist --scope user -e ELECTRON_RUN_AS_NODE=1 -- "/Applications/Todos.app/Contents/MacOS/Todos" "/Applications/Todos.app/Contents/Resources/app/src/mcp.js"
```

**Claude desktop / Cowork**: add this to `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart Claude:

```json
{
  "mcpServers": {
    "todolist": {
      "command": "/Applications/Todos.app/Contents/MacOS/Todos",
      "args": ["/Applications/Todos.app/Contents/Resources/app/src/mcp.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

If you move the app somewhere other than `/Applications`, update both paths.

### MCP tools

| Tool | What it does |
| --- | --- |
| `todo_list` | List todos with a summary. Filter by status (default: open), project, tag, assignee, text, or overdue. |
| `todo_get` | Get one todo with full notes and activity history. |
| `todo_add` | Add a todo (title, notes, status, priority, due, project, tags, assignee, subtasks, repeat, remind_at). |
| `todo_update` | Change fields, add / check off / remove subtasks, and/or post a progress `comment`. |
| `todo_complete` | Mark one or more todos done, with an optional closing comment. Completing a repeating todo creates its next occurrence. |
| `todo_delete` | Permanently delete a todo. |

Due dates accept `YYYY-MM-DD`, `today`, `tomorrow`, `yesterday`, `+3d`, `next week`, or a weekday name (`fri`).

Reminder times (`remind_at`) are in your local time and accept `YYYY-MM-DD HH:MM`, `tomorrow 9am`, `fri 14:30`, a bare time (`15:00`, meaning today), or a relative offset (`+2h`, `+30m`).

`repeat` is one of `daily`, `weekdays`, `weekly`, `biweekly`, `monthly`, `yearly`, or `none`.

The server also gives Claude usage instructions:

- Check the list when you ask what's on your plate.
- Set a task to *in progress* and assign it to Claude when it starts working on it.
- Comment on progress, and mark the task done when finished.
- Check off subtasks as it finishes them.
- Don't fill the list with its own step-by-step work items.

You can ask Claude things like:

- "What's on my todo list?"
- "Add a weekly todo to publish the changelog every Friday, and remind me at 10am."
- "Break #7 into subtasks."
- "Pick up #12 and check off the subtasks as you go."

## Data

Everything lives in `~/Library/Application Support/Todos/data/todos.json`, a plain JSON file that's easy to back up or inspect. The app, the dev server, and every MCP process all use this file, no matter where the code runs from. Writes use a lock directory plus an atomic rename, so the app and any number of Claude sessions can write at the same time safely.

## Development

```bash
npm install        # Electron + electron-builder (dev only)
npm run app        # run the app from source
npm start          # run just the dashboard server, then open http://127.0.0.1:7420
npm test           # the test suite (uses its own temporary data folder)
npm run test:app   # tests that run the real app, in the background, as a separate copy on port 7441
ios/scripts/test.sh     # the iPhone app's tests (see ios/README.md)
ios/scripts/install.sh  # build the iPhone app and install it on a connected iPhone
npm run dist       # build the todos command (needs Go), then dist/Todos-<version>-arm64.dmg
```

`npm run dist` first runs `cli/build.sh` and puts its result in the app bundle. It stops with a message if Go isn't installed or the build produces anything other than a macOS arm64 program.

`npm run test:app` starts a copy of the app with its own settings, data, socket and port, so it can run while the installed app is open. It shows an icon in the Dock for a few seconds, and one test brings the copy to the front on purpose. If the app has been packaged in this checkout, the packaged copy is tested too.

| Env var | Default | Purpose |
| --- | --- | --- |
| `TODO_DATA_FILE` | `~/Library/Application Support/Todos/data/todos.json` | Use a different data file (handy for testing) |
| `TODO_PORT` | `7420` | Dashboard port. If it's taken, the app falls back to a free port. |
| `TODOS_SOCKET` | `~/Library/Application Support/Todos/todos.sock` | Where the local socket goes. The path must be 103 bytes or shorter. `npm start` only opens a socket when this is set. |
| `TODOS_USER_DATA` | `~/Library/Application Support/Todos` | The app's settings folder. Give a second copy of the app its own, or it will find the first one running and hand over to it. |
| `TODOS_BIN_DIR` | `~/.local/bin` | Where Install Command Line Tool puts the link. |
| `TODOS_CLI_DIR` | `cli` | The command-line client that `npm run dist` builds into the app. |

### The dashboard's own routes

The dashboard uses these. The server only listens on 127.0.0.1. For anything you write yourself, use `/api/v1` (above) instead: it is documented, versioned and checks for conflicts.

```
GET    /api/todos          -> { todos, summary, version }
POST   /api/todos          { title, notes?, status?, priority?, due?, project?, tags?, assignee?,
                             subtasks?, repeat?, remindAt? }
PATCH  /api/todos/:id      { any of the fields above, comment?, add_subtasks?, check_subtasks?,
                             uncheck_subtasks?, remove_subtasks?, rename_subtask? }
                           -> { todo, next }   (next = new occurrence of a repeating todo, or null)
DELETE /api/todos/:id
GET    /api/events         server-sent events; "change" fires on every write
```
