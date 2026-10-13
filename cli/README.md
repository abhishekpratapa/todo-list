# todos: your Todos list from the terminal

`todos` is the command-line client for the Todos app. It has quick commands for scripts and one-liners, and a full interactive board (run `todos` with no arguments).

It never reads or writes the list's file. Everything goes through the running app, so there is one copy of the list, one parser for dates and one-line entries, and one set of rules about conflicts.

- **On the Mac** it talks to the app through a local socket. No token, nothing to set up. If the app isn't running, the command starts it in the background.
- **On other machines** on your tailnet (a Linux box you SSH into, say) you pair it with the Mac once, and it reaches the app over HTTPS through Tailscale.

## Installing

### On the Mac

The app carries the command inside it (in builds made with `npm run dist` from a checkout that has this folder). Choose **Todos → Install Command Line Tool**, which links `~/.local/bin/todos` to the copy in the app, then open a new terminal window:

```bash
todos status
```

To build it yourself instead (needs Go 1.26 or later):

```bash
cd cli && ./build.sh
```

That writes `cli/dist/todos-darwin-arm64`. It is also the first step of `npm run dist`, which puts the result in the app bundle.

### On a machine that only has a terminal

Build the Linux binaries on the Mac and copy one over. They are static and need nothing installed.

```bash
cd cli && ./build.sh all
```

```bash
scp cli/dist/todos-linux-amd64 my-box:.local/bin/todos
```

Use `todos-linux-arm64` for an ARM machine (`uname -m` says `aarch64`). Make sure `~/.local/bin` is on the `PATH` there.

## Pairing a machine with the Mac

On the Mac: turn on **Todos → Remote Access**. The menu shows the address (`https://your-mac.your-tailnet.ts.net`), and **Copy Access Token** gives the token.

On the other machine:

```bash
todos pair https://your-mac.your-tailnet.ts.net
```

It asks for the token without showing it. The token is never taken as an argument, so it stays out of your shell history and out of `ps`. For a script, pipe it in or use the environment:

```bash
pass show todos-token | todos pair https://your-mac.your-tailnet.ts.net --token-stdin
```

`todos pair` checks the address and the token before saving anything.

**Where the token is kept.** In the system keyring where there is one: the macOS Keychain, or the Secret Service on a Linux desktop. A machine you only reach over SSH usually has no keyring running, and there the token goes in `~/.config/todos/credentials.json`, readable only by you (mode 0600). `todos pair` says which it used. A token file that other users can read is refused, the way `ssh` refuses a private key. `--store keyring` or `--store file` forces one. `TODOS_TOKEN` in the environment is used instead of a saved token and is never written anywhere.

**One token for every device.** Todos has a single access token. To revoke a lost machine, rotate the token on the Mac (**Todos → Remote Access → Rotate Access Token**). That signs out every device, the iPhone included; pair each one again.

**Remote machines can't do everything.** Starting a Claude session on a task (`todos claude`) only works on the Mac itself. With a paired profile the command refuses and says so.

### Profiles

| Profile | What it is |
|---|---|
| `local` | Built in: the app on this Mac, through its socket. Used whenever the socket is there. |
| a name you choose | A Mac you paired with (`--name`, default: the first part of the address). |

A command uses, in order: `--profile NAME` or `TODOS_PROFILE`; the `local` profile if its socket exists; the default profile (the first one you paired, or `todos profiles use NAME`); and on a Mac with nothing else, `local`, starting the app.

```bash
todos profiles
```

Profiles are saved in `$XDG_CONFIG_HOME/todos/config.json`, which is `~/.config/todos/config.json` on macOS as well as Linux. (Not `~/Library/Application Support/todos`: on a Mac's usual case-insensitive disk that is the app's own data folder.)

## When the app isn't running

**On the Mac**, the command runs `open -g -a Todos --args --background`, which starts the server, the menu bar item, reminders and notifications with no window and without coming to the front. It then asks the app's health check every 100 ms for up to 15 seconds (`TODOS_START_TIMEOUT` changes that, in seconds).

**From another machine**, the command can start the app over SSH. Give the profile an SSH host from your own SSH setup:

```bash
todos profiles ssh your-mac my-mac
```

When the Mac answers but Todos doesn't, the command runs `ssh -o BatchMode=yes -o ConnectTimeout=10 my-mac open -g -a Todos --args --background` and waits up to 20 seconds for the app to answer. Two things have to be true:

- **You are logged in to the Mac's desktop.** macOS only lets `open` start an app inside a logged-in session. A Mac at the login window can't do it.
- **SSH connects without asking for anything.** Use keys, an agent or Tailscale SSH. `BatchMode` makes `ssh` fail rather than prompt, and no password is ever stored.

Without an SSH host, the command says the app isn't running and how to add one.

**If the Mac is asleep or offline**, the command says so. It can't wake it. To keep the Mac reachable:

- System Settings → Energy: turn on **Prevent automatic sleeping on power adapter when the display is off** (a sleeping display is fine).
- **Todos → Launch at Login**, and let Tailscale start at login too.
- Stay logged in. A Mac that restarted for an update and sits at the login window runs nothing.

### What the errors mean

| Message | What is wrong |
|---|---|
| `Todos did not start within 15s` | The app was asked to start and its socket never appeared. |
| `Todos is running, but its socket … is not there` | The app is up but has no socket. See **Todos → Why the todos Command Can't Connect…**; if there is no such menu item, that copy of the app predates the command. |
| `can't reach …: the Mac is asleep, offline or off the tailnet` | No answer at all from the Mac. |
| `can't find …: Tailscale isn't running on this machine` | The Mac's tailnet name doesn't resolve here. |
| `… is on, but Todos isn't running there` | The Mac answered; the app is not running. Add an SSH host, or open Todos. |
| `Remote Access is turned off in Todos` | The app is running but not serving other devices. |
| `the access token was rejected` | The token was rotated on the Mac. Run `todos pair` again. |
| `this todos command is too old` / `the Todos app is too old` | Update the one it names. |

`todos status` shows the profile in use and the versions on both sides, or the error above that applies.

## The board

Run `todos` with no arguments on a terminal:

```bash
todos
```

It shows the four columns (To do, In progress, Blocked, Done) with a card for each task: title, priority, due date, project, tags, who has it and checklist progress. The tiles along the top are the dashboard's, and each is a filter. Changes made anywhere else (the app, the iPhone, a Claude session, another terminal) appear by themselves.

Below 80 columns the board becomes a single list grouped by status. From 110 columns, an open task is shown beside the board; on anything narrower it takes the whole screen.

| Key | What it does |
|---|---|
| `↑` `↓` or `k` `j` | Move between cards |
| `←` `→` or `h` `l` | Move between columns |
| `g` `G` | First and last card |
| `tab` `shift+tab`, or `1`–`5` | Choose a tile: Open, Due today, Overdue, With Claude, Done this week |
| `/` | Search titles, notes, projects, tags and subtasks. `enter` keeps the filter, `esc` clears it |
| `enter` | Open the task: notes, subtasks, comments, history, repeat and reminder |
| `esc` | Back; clear the search or the filter |
| `r` | Read the list again |
| `?` | All the keys |
| `q` | Quit |

Changing things, on the selected card or in an open task:

| Key | What it does |
|---|---|
| `a` | Add a task from one line, in the same syntax as `todos add`. As you type, the bottom line shows how the app reads it |
| `H` `L` (or `shift+←` `shift+→`) | Move the card one column left or right |
| `s` `b` `x` | Start it, block it, finish it |
| `e` | Edit its fields in a form: title, due, priority, project, tags, who has it, repeat, reminder |
| `c` | Add a comment |
| `+` | Add a subtask |
| `space`, `1`–`9` | In an open task: check off the next subtask, or check and uncheck the one with that number |
| `d` | Delete it, after asking (`y` deletes; anything else doesn't) |
| `n` | Edit its notes in your editor (`$VISUAL`, then `$EDITOR`, then `vi`). The board steps aside and comes back when you close it |
| `C` | Start a Claude session on it, in this terminal (on the Mac only). The board comes back when Claude exits |

**If a task changes while you are editing it**, the form says so. `ctrl+r` drops your edit and loads the new version; or you can carry on and save. If what you changed is something they didn't touch, both changes are kept. If you both changed the same field, nothing is saved: the two versions are shown side by side and you choose: yours over theirs (`o`), theirs (`t`), or back to the form with your text on top of their version (`e`). The same goes for moving a card someone has just moved. A task that changed after you were asked "delete?" is not deleted.

The line at the bottom says how things stand: `● live` while changes are arriving as they happen (`○ reconnecting` when the connection has dropped and is being reopened), the profile, how long ago the list was read, and anything that went wrong.

Colors follow the app's, in a light and a dark form chosen by asking the terminal for its background. `TODOS_THEME=light` or `dark` decides instead. The selected card is marked with a bar as well as by color, so it shows in any terminal. The mouse is left alone so the terminal's own text selection keeps working; `todos --mouse` lets the board take clicks and the wheel.

It works the same over SSH: it only needs a terminal.

## Commands

A task is named by its number (`12` or `#12`) or by words from its title (`todos done passport`). If the words match several open tasks, you are asked which on a terminal; in a script the command fails and lists them.

| Command | What it does |
|---|---|
| `todos` | The interactive board on a terminal; `todos ls` when piped. |
| `todos add "<line>"` | Add a task from one line (see below). No line: a short form. `-`: one task per line of standard input. |
| `todos ls` | List open tasks. `--status`, `--all`, `--tag`, `--project`, `--priority`, `--assignee`, `--due today\|week\|overdue\|none\|any\|DATE`, `--search`, `--limit`. |
| `todos due` | What the Mac's menu bar shows: overdue, today, the next 7 days, no date. |
| `todos show <task>` | Everything about one task. Notes are rendered on a terminal. |
| `todos done <task>…` | Mark done. `-m "comment"`. A repeating task gets its next occurrence. |
| `todos start <task>…` | Move to In progress. |
| `todos block <task>…` | Move to Blocked. `-m "what it is waiting on"`. |
| `todos reopen <task>…` | Move back to To do. |
| `todos edit <task>` | `--title --notes --due --priority --project --tags --assignee --repeat --remind --status`. `--notes -` reads standard input; `--editor` opens the notes in your editor; an empty value clears a field. |
| `todos rm <task>` | Delete, after asking. `--yes` doesn't ask. |
| `todos sub add <task> <title>…` | Add subtasks. Also `sub done`, `sub undo`, `sub rm <task> <subtask>…`, where a subtask is its number or words from its title. |
| `todos comment <task> <text>` | Add a comment. `-` reads standard input. |
| `todos watch` | Print changes as they happen, whoever makes them. Ctrl-C stops it. |
| `todos claude <task>` | Start a Claude session on the task in this terminal. On the Mac only; see below. |
| `todos pair`, `todos profiles`, `todos status` | Connecting; see above. |
| `todos version`, `todos completion <shell>` | |

Every command takes `--profile NAME`, `--json`, `--no-color` and `--no-input`. `todos <command> --help` has the details and examples.

### One-line entry

`todos add` sends the line to the app, which reads it exactly as its quick-capture box does:

```bash
todos add "Renew passport fri !high #personal @errand"
```

| In the line | Means |
|---|---|
| `today`, `tomorrow`, `fri`, `next week`, `in 3 days`, `oct 20`, `2026-10-20` | Due date |
| `3pm`, `9:30am`, `15:00` | A reminder at that time |
| `every day`, `every week`, `every friday`, `every month` | Repeats |
| `!high` `!med` `!low` | Priority |
| `#name` | Project |
| `@name` | Tag (`@claude` and `@me` set who has it) |

Dates, reminder times and repeats given to `todos edit` are read by the app too, so `--due fri` and `--remind "tomorrow 9am"` work. "Today" is today on the Mac.

### Starting Claude on a task

```bash
todos claude 12
```

This is the app's **Start with Claude**, in the terminal you are in. It asks the app what a session on the task is started with (the opening message, the options, and the folder it remembers for the task's project), hands the task to Claude with a note in its history ("Started with Claude from terminal in ~/code/site"), and then runs `claude` in place of itself.

The session starts in `--dir` if you give one, otherwise in the folder the app remembers for the task's project, otherwise in the folder you are in. `--dir .` starts it here whatever is remembered. The folder used is remembered for the project. `--dry-run` prints the command without running it or recording anything.

It uses the `claude` on your `PATH`, or the one the app found. `TODOS_CLAUDE_BIN` names a specific one.

**On the Mac only.** With a paired profile the command refuses (exit 9) before sending anything: starting programs on the Mac, and where its folders are, stay on the Mac. The app does not serve this over the network either.

### Shell completion

Completion covers commands, flags, flag values and open tasks (by number, with the title shown). It asks the app for the tasks and never starts it.

```bash
# zsh: once, then open a new terminal
todos completion zsh > "${fpath[1]}/_todos"
```

```bash
# bash (needs bash-completion): in ~/.bashrc
source <(todos completion bash)
```

```bash
# fish
todos completion fish > ~/.config/fish/completions/todos.fish
```

### Changing a task someone else is changing

Every task has a revision that goes up with each change, whoever makes it. `done`, `comment` and `sub` add to a task and can't overwrite anything. `start`, `block`, `reopen` and `edit` read the task and base their change on that revision. If someone changes the **same fields** in that instant, nothing is overwritten and the command exits 4. If they changed other fields, both changes stand.

- `--rev N` is stricter: the change is made only if the task is still at revision `N` (as `--json` shows it).
- `--force` overwrites whatever is there.

`rm` deletes the task as it was when you were asked. If it changed while you were deciding, it is not deleted.

Every change carries an idempotency key, so a change that is sent again after a dropped connection is not applied twice.

## Scripting

### Output

When standard output is not a terminal there are no colors, no spinners and no questions. A command that would have to ask fails instead, with a message saying which flag answers it. `NO_COLOR` and `--no-color` remove color on a terminal too. Results go to standard output, errors to standard error, one line.

**Plain output** is one task per line, tab-separated: id, status, priority, due (`-` if none), title.

```bash
todos ls --due overdue | cut -f1,5
```

Commands that change a task print that task's line, so the first field is its id:

```bash
id=$(todos add "Call the bank tomorrow" | cut -f1)
todos sub add "$id" "Find the account number"
```

`todos rm` prints the id it deleted. `todos watch` puts `created`, `updated` or `deleted` in front of the line.

### JSON

`--json` works on every command. Tasks are passed through exactly as the app's API sends them, so the schema is the API's: `Task`, `TaskSummary` and `Counts` in [`docs/openapi.json`](../docs/openapi.json). Within API version 1 fields are only ever added.

| Command | Standard output |
|---|---|
| `ls` | `{"tasks": [TaskSummary], "total": n, "summary": Counts, "version": n}` |
| `due` | `{"overdue": [], "today": [], "upcoming": [], "undated": [], "later": [], "counts": {}, "date": "YYYY-MM-DD"}` |
| `show` | `{"task": Task}` |
| `add` | `{"task": Task, "next": null, "parsed": {"title": "", "fields": {}}}` |
| `done` `start` `block` `reopen` `edit` `sub` `comment` | `{"task": Task, "next": Task or null}` (`next` is the new occurrence of a repeating task) |
| `rm` | `{"deleted": {"id": n, "title": ""}}` |
| `watch` | One object per line: `{"event": "created\|updated\|deleted", "version": n, "task": TaskSummary, "changed": ["status"]}` |
| `status` | `{"profile": "", "transport": "socket\|https", "address": "", "appVersion": "", "apiVersion": {"version": 1, "revision": 4}, "cliVersion": "", "minClientVersions": {}}` |
| `profiles` | `{"profiles": [{"name": "", "url": "", "ssh": "", "tokenStore": "", "default": false, "current": false}], "default": ""}` |

A `Task` has `id`, `title`, `notes`, `status` (`todo`, `in_progress`, `blocked`, `done`), `priority` (`high`, `medium`, `low`), `due` (`YYYY-MM-DD` or null), `project`, `tags`, `assignee` (`me`, `claude`), `subtasks` (`[{id, title, done}]`), `repeat`, `remindAt`, `remindedAt`, `rev`, `createdBy`, `createdAt`, `updatedAt`, `completedAt` and `activity` (`[{at, by, kind, text, via}]`). A `TaskSummary` is the same without `activity`, plus `comments` (a count).

On a terminal the JSON is indented; in a pipe each value is one line. A command given several tasks (`todos done 3 4 --json`) prints one object per line.

With `--json`, an error is an object on standard error: `{"error": {"code": "conflict", "message": "…", "current": Task}}`. `current` is there for conflicts.

```bash
todos ls --json | jq -r '.tasks[] | select(.priority == "high") | "\(.id)\t\(.title)"'
```

```bash
todos watch --json | jq -r 'select(.event == "created") | .task.title'
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. |
| 1 | Something else went wrong. |
| 2 | Wrong usage: a bad flag or value, a name that matches several tasks, or a question with no terminal to ask it on. |
| 3 | No such task or subtask. |
| 4 | Conflict: the task changed, and nothing was overwritten. |
| 5 | Can't reach Todos: the Mac is asleep or offline, Tailscale is down, Remote Access is off, or the app isn't running on the other Mac. |
| 6 | The access token was rejected (or there is none). |
| 7 | Todos is not running and could not be started. |
| 8 | Version mismatch: the command or the app is too old for the other. |
| 9 | Not possible with this profile: a Mac-only command on a remote profile, or no profile yet. |
| 10 | Rate limited or too many connections. Try again shortly. |
| 130 | Interrupted, or a question answered with no. |

```bash
if todos edit 12 --status done --rev "$rev"; then echo updated
elif [ $? -eq 4 ]; then echo "someone else changed it first"
fi
```

## Environment

| Variable | What it does |
|---|---|
| `TODOS_PROFILE` | The profile to use, like `--profile`. |
| `TODOS_TOKEN` | The access token, instead of the saved one. Never written anywhere. |
| `TODOS_TOKEN_STORE` | `keyring` or `file`: where `todos pair` keeps tokens. |
| `TODOS_SOCKET` | Where the app's socket is, if not the usual place. Must match the app's own `TODOS_SOCKET`. |
| `TODOS_START_TIMEOUT` | Seconds to wait for the app to start. |
| `TODOS_LAUNCH_CMD` | A shell command that starts the app, instead of `open`. For a copy run from source. |
| `TODOS_SSH` | The `ssh` program to use. |
| `TODOS_CLAUDE_BIN` | The `claude` program to use, as in the app. |
| `VISUAL`, `EDITOR` | The editor for notes. |
| `TODOS_CA_FILE` | Extra certificate authorities to trust (PEM), for a hub that isn't behind Tailscale's certificates. |
| `TODOS_THEME` | `light` or `dark`, instead of asking the terminal. |
| `NO_COLOR` | No color. |
| `XDG_CONFIG_HOME` | Where the config folder is (default `~/.config`). |

## Developing

```bash
cd cli && go test ./...
```

The tests never touch the installed app, its port (7420), its socket or its data.

- **Unit tests** cover the connection layer over a socket and over HTTPS, profiles, token storage, starting the app and waiting for it, building the SSH command, output formats, exit codes, and the board (golden files of what it draws at several sizes, and each change and conflict).
- **Integration tests** (`internal/integration`) run the built binary, directly and inside a pseudo-terminal, against two servers, each reached through a Unix socket and over HTTPS: a fake one (`internal/fakeserver`), which can also misbehave on request, and the **real Todos server** from this repository (`src/server.js`), started on port 7442 with its own data file, token and socket in a temporary folder. A small relay stands in for `tailscale serve`. The real-server tests are skipped where Node or the app's sources aren't available.
- **The real app.** One test starts Todos itself (Electron), in the background, through the command, with its own settings, data, socket and port. It is off unless asked for, because it puts an icon in the Dock for a few seconds:

```bash
TODOS_TEST_ELECTRON="$PWD/../node_modules/electron/dist/Electron.app" go test ./internal/integration -run TestTheRealApp -v
```

```bash
TODOS_TEST_APP="$PWD/../dist/mac-arm64/Todos.app" go test ./internal/integration -run TestTheRealApp -v
```

The first runs the app from this repository's sources. The second runs a packaged app (after `npm run dist`) and uses the `todos` inside it.

`go test -short ./...` leaves out one test that waits for a connection to time out. `go test ./internal/... -update` rewrites the golden files.

Dependencies are Charm's libraries (Bubble Tea, Bubbles, Lip Gloss, Glamour, Huh and Fang, all v2 at `charm.land/...`) and two others: [cobra](https://github.com/spf13/cobra), which Fang is built on and which provides the command tree and shell completions, and [go-keyring](https://github.com/zalando/go-keyring), for the macOS Keychain and the Linux Secret Service without cgo.

## Not included

- **A Homebrew tap.** It would take a public tap repository with a formula, and tagged releases with an archive and checksum per platform for the formula to point at (GoReleaser can produce both). On the Mac the command should still come from the app, so the two always match; a tap would mostly serve Linux machines.
- **Serving the board over SSH (Wish).** With Tailscale SSH and a binary on each machine there is little it would add, and a listener on the Mac that runs the board against the local socket would put the Mac-only operations on the network.
- **Windows.**
