# todos: your Todos list from the terminal

`todos` is the command-line client for the Todos app. It has quick commands for scripts and one-liners, and a full interactive board (run `todos` with no arguments).

It never reads or writes the list's file. Everything goes through the running app, so there is one copy of the list, one parser for dates and one-line entries, and one set of rules about conflicts.

- **On the Mac** it talks to the app through a local socket. No token, nothing to set up. If the app isn't running, the command starts it in the background.
- **On other machines** on your tailnet (a Linux box you SSH into, say) you pair it with the Mac once, and it reaches the app over HTTPS through Tailscale. Tasks added while the Mac can't be reached are saved and sent when it can be ([Working offline](#working-offline)).

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

## Working offline

On a paired profile, when the Mac can't be reached (asleep, offline, off the tailnet, or Todos not running there), changes that only add something are saved on this machine and sent when it can be:

| Command | Saved |
|---|---|
| `todos add "<line>"`, `todos add -` | The line, read as of when you typed it: "tomorrow" is the day after you typed it, not the day after it arrives. |
| `todos done <number>` | With its `-m` comment. |
| `todos comment <number> <text>` | |
| `todos sub add <number> <title>…` | |

The task has to be given by its number, because its title can't be looked up without the Mac. Everything else needs the Mac and fails as before (exit 5): listing, `edit`, `start`, `block`, `reopen`, `rm`, the habit commands, the board. Those would change a task as it is now, which only the Mac knows.

```bash
todos add "Call the bank tomorrow"
```

On a terminal that prints `◷ Saved for later  add “Call the bank tomorrow”`. In a script, standard output is empty (there is no task yet, so no id), standard error says what was saved, and the exit code is 0.

**When they are sent.** First thing in the next command that reaches the Mac, before it does its own work, so what it lists or changes comes after them; on a terminal it says what it sent. If they can't all go (the app says it is getting too many, say), the command says why and goes on with its own work, and the rest follow in the background.

Meanwhile a sender left running in the background tries again after 2 seconds, then at doubling intervals up to a minute, until a day after the newest change was saved. So they go as soon as the Mac is back, even if you run nothing. Only one runs per profile, and it stops once everything has gone. It never starts Todos over SSH; the next command you run does that, as usual.

Each change keeps the idempotency key it was made with, so one that reached the app before the connection dropped is not made twice. A change whose connection dropped partway is saved the same way. If this machine's clock is more than five minutes ahead of the Mac's, the app won't take a time it hasn't reached yet; a line typed so recently is then read as of when it arrives.

**Turned down.** If the app refuses a change (the task was deleted in the meantime, or a line has nothing but markers in it), the change is marked, stays in the queue, and the rest go on. The command that sent it says so on standard error, and on a terminal every command after that reminds you, until you remove it with `todos queue rm`. `todos queue` shows why. (With `--json`, nothing is said: look at `todos queue --json`, or `queue` in `todos status --json`.)

| Command | What it does |
|---|---|
| `todos queue` | What is waiting, oldest first, and what was turned down. Needs no connection. |
| `todos queue send` | Send now. `--wait` keeps trying until the Mac answers (for a day at most). |
| `todos queue rm <n>…` | Remove changes without sending them. `--all` removes every one. If the queue is being sent at that moment, it waits for that to finish. |

`TODOS_QUEUE=manual` saves changes but leaves no sender in the background: they go with the next command, or `todos queue send`. `TODOS_QUEUE=off` saves nothing, and a command that can't reach the Mac fails (exit 5) as it would without the queue.

The queue is kept in `~/.config/todos/queue/<profile>/`, one file per change, readable only by you. A file there that isn't a change is renamed `*.unreadable` and left alone, and `todos queue` mentions it. Changes are only sent to the address they were saved for: if the profile has since been paired with another Mac, they are turned down rather than sent there.

On the Mac itself there is nothing to wait for: the command starts the app when it isn't running.

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

### Habits on the board

If you have [habits](../README.md#habits), the bottom line also says how many check-ins are left today, and `t` opens the habits panel: what is still to do (soonest first), what is done, and what asks nothing today, each with how today stands, its streak, and its times of day. It follows check-ins made anywhere else as they happen.

| Key | What it does |
|---|---|
| `↑` `↓` or `k` `j`, `g` `G` | Move between habits |
| `x` (or `enter`, `space`) | Check in whichever time of day is still to do. The app picks, by the hour, and the bottom line says which it took |
| `1`–`9` | That time of day: checks it in, or takes it back if it is done |
| `u` | Take back all of today's check-ins for the habit |
| `y` | Log yesterday's next missing time of day, which is possible until today ends. When a streak hangs on it, the panel says so under the habit |
| `s` | A rest day (a rest week, for a habit counted in weeks); `s` again takes it back |
| `esc`, `t` or `q` | Back to the board |

With a Todos app from before habits, none of this shows and the board is as it was.

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
| `todos watch` | Print changes to tasks as they happen, whoever makes them. Ctrl-C stops it. |
| `todos habit` | List habits in the order of the day, with how today stands and each streak. The same as `todos habit ls`; `--all` includes archived ones. |
| `todos habit done <habit>…` | Check in. `--slot morning` says which time of day; without it the app takes whichever is still to do. `--yesterday` logs yesterday, which is possible until today ends. |
| `todos habit undo <habit>…` | Take back today's check-ins (`--slot` for one time of day, `--yesterday` for yesterday's). |
| `todos habit skip <habit>…` | A rest day: it neither breaks the streak nor adds to it. `-m "why"`, `--yesterday`, and `--undo` to take it back. |
| `todos claude <task>` | Start a Claude session on the task in this terminal. On the Mac only; see below. |
| `todos pair`, `todos profiles`, `todos status` | Connecting; see above. |
| `todos queue` | Changes saved while the Mac couldn't be reached. Also `queue send` and `queue rm`; see [Working offline](#working-offline). |
| `todos version`, `todos completion <shell>` | |

Every command takes `--profile NAME`, `--json`, `--no-color` and `--no-input`. `todos <command> --help` has the details and examples.

### Habits

A habit is named like a task: by its number, or by words from its name (`todos habit done floss`). An exact name wins over longer names that contain it, and if the words match several habits you are asked which on a terminal; in a script the command fails and lists them.

```bash
todos habit
```

```bash
todos habit done brush --slot evening
```

Checking in something that is already done changes nothing and is not an error, so a script can run `todos habit done` without looking first. The app's own limits come back as it words them, with exit code 2: a time of day the habit doesn't have, a day further back than yesterday, more rest days than it allows (2 in any 7 and 6 in any 30).

Streaks are worked out by the app and printed as they are: the numbers here are the ones the Mac window and the iPhone show. Habits are made and edited in the iPhone app; the command lists them, checks them in and rests them.

Habits need Todos 1.6.2 or later on the Mac (API revision 5). With an older one the habit commands say so (exit code 8) and everything else works as before.

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

`todos rm` prints the id it deleted. `todos watch` puts `created`, `updated` or `deleted` in front of the line. A change saved for later prints nothing on standard output, since there is no task yet.

**`todos queue`** is one line per change: its number, `waiting` or `refused`, when it was made (RFC 3339), the kind (`add`, `done`, `comment` or `subtasks`), the task (`-` if none), the text (`-` if none), and why it was refused (`-` if it wasn't).

**A habit** is one line too: id, where it stands today (`due`, `done`, `off`, `paused` or `archived`), today's count (`1/2`: times of day done out of those it has; for a habit counted in weeks, days this week out of its target), its streak (`12d`, or `3w` in weeks) and its name. `todos habit` prints them in the order of the day, and the commands that change a habit print that habit's line.

```bash
todos habit | awk -F'\t' '$2 == "due" { print $5 }'
```

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
| `habit`, `habit ls` | `{"habits": [Habit], "zone": "America/Chicago", "version": n}` |
| `habit done` | `{"habit": Habit, "checkin": HabitCheckin or null}` (`null` when there was nothing left to check in) |
| `habit undo`, `habit skip --undo` | `{"habit": Habit}` |
| `habit skip` | `{"habit": Habit, "skip": HabitCheckin or null}` (`null` when there was nothing to rest) |
| `add` `done` `comment` `sub add`, saved for later | `{"queued": QueuedChange}` |
| `queue`, `queue ls` | `{"profile": "", "changes": [QueuedChange], "setAside": 0}` (`setAside`: files in the queue's folder that weren't changes) |
| `queue send` | One object per line: `{"sent": QueuedChange, "task": Task, "next": Task or null}` for a change made, `{"refused": QueuedChange}` for one turned down |
| `status` | `{"profile": "", "transport": "socket\|https", "address": "", "appVersion": "", "apiVersion": {"version": 1, "revision": 4}, "cliVersion": "", "minClientVersions": {}, "queue": {"waiting": 0, "refused": 0}}` |
| `profiles` | `{"profiles": [{"name": "", "url": "", "ssh": "", "tokenStore": "", "default": false, "current": false}], "default": ""}` |

A `Task` has `id`, `title`, `notes`, `status` (`todo`, `in_progress`, `blocked`, `done`), `priority` (`high`, `medium`, `low`), `due` (`YYYY-MM-DD` or null), `project`, `tags`, `assignee` (`me`, `claude`), `subtasks` (`[{id, title, done}]`), `repeat`, `remindAt`, `remindedAt`, `rev`, `createdBy`, `createdAt`, `updatedAt`, `completedAt` and `activity` (`[{at, by, kind, text, via}]`). A `TaskSummary` is the same without `activity`, plus `comments` (a count).

A `QueuedChange` is this command's own, not the API's: `id` (its number in the queue), `kind` (`add`, `done`, `comment`, `subtasks`), `task`, `text`, `titles`, `made` (when the command was run), `url` (the Todos it is for), `key` (its idempotency key), and `refused` (`{status, code, message, at}`) once the app has turned it down.

A `Habit` (also in `docs/openapi.json`) has `id`, `name`, `icon`, `color`, `dayStart`, `schedule`, `paused`, `archived`, `rev`, `today` and `yesterday` (for a habit with times of day: `{day, state, done, total, slots: [{id, done, at, by, via, source}]}`; for one counted in weeks: `{day, done}` plus `week: {start, state, count, target, days}`), `streak` (`{current, best, unit, atRisk, previous}`), `rates` and `skipsLeft`.

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
| 3 | No such task, subtask or habit. |
| 4 | Conflict: the task changed, and nothing was overwritten. |
| 5 | Can't reach Todos: the Mac is asleep or offline, Tailscale is down, Remote Access is off, or the app isn't running on the other Mac. (A change that can wait is saved instead, with exit 0: see [Working offline](#working-offline).) |
| 6 | The access token was rejected (or there is none). |
| 7 | Todos is not running and could not be started. |
| 8 | Version mismatch: the command or the app is too old for the other, or the app is too old for habits (everything else then still works). |
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
| `TODOS_QUEUE` | `manual`: save changes made while the Mac can't be reached, with no sender in the background. `off`: save nothing, and fail. |
| `NO_COLOR` | No color. |
| `XDG_CONFIG_HOME` | Where the config folder is (default `~/.config`). |

## Developing

```bash
cd cli && go test ./...
```

The tests never touch the installed app, its port (7420), its socket or its data.

- **Unit tests** cover the connection layer over a socket and over HTTPS, profiles, token storage, starting the app and waiting for it, building the SSH command, output formats, exit codes, the board (golden files of what it draws at several sizes, and each change and conflict), and habits: the commands, their output for a terminal, a pipe and `--json`, the order and wording of the day, and the board's panel. The offline queue is tested through a gate (`fakeserver.Gate`) that takes the Mac away and brings it back at the same address: saving, sending in order with the saved keys, a dropped connection not making a change twice, changes turned down, and the sender in the background.
- **Integration tests** (`internal/integration`) run the built binary, directly and inside a pseudo-terminal, against two servers, each reached through a Unix socket and over HTTPS: a fake one (`internal/fakeserver`), which can also misbehave on request, and the **real Todos server** from this repository (`src/server.js`), started on port 7442 with its own data file, token and socket in a temporary folder. A small relay stands in for `tailscale serve`. The real-server tests are skipped where Node or the app's sources aren't available. The habit commands and the board's habits panel run against both as well; the fake keeps no history and works no streaks out, so it is the real server that shows a check-in giving the streak it should.
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
