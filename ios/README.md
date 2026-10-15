# Todos for iPhone

A native iPhone app for the list kept by the Todos app on your Mac. The Mac stays the only copy: the iPhone reaches it over your Tailscale tailnet, through the same `/api/v1` any other client uses (`docs/openapi.json`).

It does pairing, the task list and detail, editing, quick capture, habits with streaks, and live updates, and it keeps working without a connection: the list is kept on the iPhone, and changes made offline are sent when the Mac can be reached again. It also has reminders as notifications on the iPhone, three widgets (one with buttons that check in habits, one with the year's habits as a dot a day), Shortcuts actions (for Siri and the Action button too) and a share sheet extension.

```
Todos.xcodeproj   the Xcode project (app and its tests)
Todos/            the app: SwiftUI views and AppModel, the state they share
TodosWidget/      the home screen and lock screen widgets
TodosShare/       the share sheet extension
TodosTests/       tests that run inside the app: Keychain storage, pairing, offline use
TodosKit/         a Swift package with everything that has no user interface:
                  the API client, live updates, pairing codes, Keychain storage,
                  the list kept on disk, the queue of changes and how it is sent
                  and merged, version checks, connection diagnosis, Markdown,
                  habits and the phone's own reckoning of them between syncs
Config/           entitlements and Info.plist additions for the app and its two extensions
scripts/          install.sh, test.sh, simulator.sh, and the Todos server the tests run against
```

There are no third-party dependencies.

## What you need

- A Mac with **Xcode 16 or later** and Node.js (which the Mac app's own development already needs).
- A paid Apple Developer account, signed in under **Xcode → Settings → Accounts**. The project signs automatically with team `N3366NR59J`.
- An iPhone on **iOS 18 or later**, with the **Tailscale** app connected to the same tailnet and account as the Mac.
- **Todos 1.6 or later** on the Mac, with **Remote Access** on (Todos → Remote Access → Allow Access from My Other Devices). The app checks this when it connects and says so if the Mac's Todos is too old.

## One-time setup

1. Point the command-line tools at Xcode and accept its license:

   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   ```

   ```bash
   sudo xcodebuild -license
   ```

   ```bash
   xcodebuild -runFirstLaunch
   ```

2. On the iPhone, turn on **Settings → Privacy & Security → Developer Mode** and restart when asked.
3. Connect the iPhone to the Mac by cable, unlock it and tap **Trust**. After this first time, installs also work over Wi-Fi when both are on the same network.

## Build, sign and install

```bash
ios/scripts/install.sh
```

This builds the app with its widget and share extension, signs them, installs them on the connected iPhone and opens the app. Signing is automatic: the first run registers the iPhone, three identifiers (`com.abhishekpratapa.todos.ios`, and the same with `.widget` and `.share` on the end) and the app group (`group.com.abhishekpratapa.todos`) with your developer account, and creates development provisioning profiles; later runs reuse them.

A development build does not last for ever: it stops opening when its provisioning profile expires (a year after it was made), and possibly sooner if the Apple Development certificate it was signed with expires first. If the app stops opening, run the script again: it renews what has expired and puts a fresh build on the phone. Your list is on the Mac and the token is in the Keychain, so nothing is lost. To see the profile's date:

```bash
security cms -D -i ios/build/Build/Products/Release-iphoneos/Todos.app/embedded.mobileprovision | plutil -extract ExpirationDate raw -
```

With more than one iPhone connected, name the one you mean:

```bash
TODOS_DEVICE="My iPhone" ios/scripts/install.sh
```

What the script runs, if you would rather do it by hand (`<udid>` comes from `xcrun devicectl list devices`):

```bash
xcodebuild -project ios/Todos.xcodeproj -scheme Todos -configuration Release -destination "platform=iOS,id=<udid>" -derivedDataPath ios/build -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
```

```bash
xcrun devicectl device install app --device <udid> ios/build/Build/Products/Release-iphoneos/Todos.app
```

```bash
xcrun devicectl device process launch --device <udid> com.abhishekpratapa.todos.ios
```

## Pair the iPhone with your Mac

1. On the Mac, choose **Todos → Remote Access → Pair iPhone…**. A window shows a QR code for one minute.
2. In Todos on the iPhone, tap **Scan Code** and point the camera at it.

Or enter the two values yourself: **Copy Address** and **Copy Access Token** in the same menu on the Mac. With Handoff on, what you copy on the Mac can be pasted on the iPhone.

The token is checked against the Mac before it is kept, and then stored in the iPhone's Keychain only: readable after the first unlock, never synced to iCloud, never restored onto another device. **Unpair This iPhone** in the app's settings removes it. To sign out every device at once, use **Rotate Access Token…** on the Mac.

## Using it

- **The list.** The Mac's four columns are sections. The control at the top picks which show: Open (in progress, blocked and to do together), To do, Doing, Blocked or Done. The filter button narrows to due today, overdue, with Claude, or one project, and search looks through titles, notes, tags and subtasks.
- **Swipes.** Right to complete (or reopen). Left to move a task to another column or delete it; deleting asks first. Touch and hold for priority, due date and assignee.
- **A task.** Title, status, priority, assignee, due date, reminder, repeat, project, tags, Markdown notes with tappable links, subtasks with progress, comments and history. Each control saves as soon as you change it.
- **Quick capture.** The **+** button is on every screen. Type one line, read by the Mac exactly as its own capture box reads it (`Renew passport fri !high #personal`). What it understood shows as you type.
- **Live updates.** While the app is open, changes made on the Mac or by a Claude session appear by themselves. iOS closes the connection when the app goes to the background; the list refreshes when you come back.
- **Offline.** The list, with notes, comments and history, is kept on the iPhone, so the app opens at once and can be read anywhere. Changes you make without a connection are saved on the iPhone, shown straight away with a small clock, and sent in order as soon as the Mac can be reached. A line of quick capture waits as you typed it under **Waiting for your Mac**; the Mac reads it when it arrives, with "tomorrow" counted from when you typed it. The line at the bottom of the list says when it was last updated and how many changes are waiting; tap it for the **Sync** screen.
- **Start with Claude** is only in the Mac app, so it isn't shown here. You can still assign a task to Claude.
- Your changes appear in a task's history on the Mac as "You · iPhone".

### Habits

The **Habits** tab is for routines you check in on: brushing your teeth morning and evening, the gym three times a week. What a habit is, and exactly how streaks, late logging, rest days and pauses work, is in the [main README](../README.md#habits); the Mac keeps the record and works the streaks out. Habits need Todos 1.6.2 or later on your Mac (API revision 5). With an older one the tab says so, and tasks work as before.

- **Today.** What is still to do comes first, soonest first, then what is done, then what expects nothing today. Each habit shows its streak (a flame and a number) and a round button for each time of day. **Tap a button to check in; tap it again to take it back.** The tab's badge counts what is left today.
- **Yesterday.** If yesterday was left unfinished and a streak hangs on it, it is offered at the top, where it can be logged until today ends.
- **A habit.** Tap its name for the streak and the best one, today and yesterday, a calendar of the last 18 weeks, completion over 7, 30 and 365 days, and **Skip Today**, **Pause**, **Archive** and **Delete**. The calendar is drawn from the Mac's record, so it needs the Mac to be reachable.
- **New habit.** The **+** button offers Twice a Day, Every Day and 3 Times a Week, and opens a form already filled in: name, emoji and color, when it repeats, each time of day with its reminder time, the hours it belongs in and an optional second reminder, and when the habit's day starts (3 AM unless you change it).
- **Offline.** Check-ins, taking one back, and rest days all work with no connection. They show at once, with the streak they will give, and are sent in order when the Mac can be reached; each says when and where it was really made, so one made on Monday and delivered on Thursday is Monday's. If days go by with no connection, the phone works out for itself how the days in between went, by the same rules as the Mac, and the Mac's answer replaces that the next time it is reached.
- **Without opening the app.** A habit can also be checked in from its reminder (**Done**), from the [Habits widget](#widgets), and from Shortcuts or Siri with [**Log Habit**](#shortcuts-siri-and-the-action-button). All three go through the same queue as a check-in made in the app.
- **What needs the Mac.** Making, editing, pausing, archiving and deleting a habit. If the Mac can't be reached you are told so, and nothing is queued: a habit the Mac hasn't accepted has nothing useful to show.
- **Travel.** A check-in counts for the date where you are. The app tells the Mac which time zone the phone is in whenever it differs, so "today" follows you.

### Reminders on the iPhone

Reminders are local notifications scheduled on the iPhone itself, from what the phone has, so they arrive even when your Mac is asleep or out of reach.

**For tasks,** turn on **Settings → Reminders on This iPhone** (the gear at the top left) and allow notifications when iOS asks. Tapping one opens its task.

- A reminder set on the Mac reaches the phone the next time the app updates: at once if the app is open, otherwise when iOS next gives it a background refresh (iOS decides when; opening the app always does it).
- To be reminded only once, turn off **Todos → Reminder Notifications on This Mac** on the Mac. Each device has its own switch, so you choose where reminders appear.

**For habits,** reminders are on unless you turn off **Settings → Habit Reminders on This iPhone**; the phone is where they are meant to come from. iOS asks for permission the first time there is a habit with a reminder time.

- **When.** At each time of day's reminder time, and again at its second reminder time if it still isn't done. For a habit counted in weeks, on its reminder days until the week is met. Times are local wherever you are: 7:30 is 7:30 at home and abroad.
- **Done** on the notification checks in without opening the app. It goes through the same queue as a check-in made in the app, so it is kept if the Mac can't be reached and sent later. **Snooze 15 min** brings the same reminder back in a quarter of an hour. Tapping the notification itself opens the habit.
- **Checking in early cancels the reminder** for that time of day, its second reminder, and anything about it already on screen or snoozed. That goes for a check-in made in the app, on the widget or from Shortcuts. A check-in made on the Mac or with the `todos` command cancels the phone's reminder only once the phone has heard of it: at once if the app is open, otherwise at its next background refresh.
- Yesterday's reminder still works the next day (it logs yesterday, late). One from further back says it is too late.

**How they fit in what iOS allows.** iOS keeps at most 64 waiting notifications for an app and silently forgets the rest, so reminders can't all be scheduled forever ahead. Instead the nearest are, and the schedule is laid out again every time the app runs: when you open it, when iOS wakes it to refresh, after every check-in, and after every Done or Snooze.

- One place is for a notice, and three are kept for snoozes. Task reminders have first call on 24 of the rest and habits use the others; either side may use what the other leaves. With no habits, tasks have the 60 they always had.
- Reminders are scheduled soonest first, so what is left out is always the furthest away. Two habits done twice a day reach about a week and a half ahead.
- **Never silently.** The first reminder that did not fit is replaced, at its time, by a notice saying that reminders stop there until Todos is opened. Settings shows the date habit reminders are scheduled through.
- If there are so many that today's and tomorrow's don't all fit, second reminders are left out before any first reminder is, and Settings says so.

### Widgets

There are three: **Due Today** for tasks, **Habits**, and **Habit Year**. Touch and hold the home screen, tap **Edit → Add Widget**, choose **Todos**, swipe to the one and the size you want and tap **Add Widget**. For the Lock Screen, touch and hold it, tap **Customize**, then the Lock Screen, then **Add Widgets**, and choose **Todos**.

**Due Today.** Tapping a task opens it.

| Size | Shows |
| --- | --- |
| Small, medium | The count, and the first three or four tasks that are overdue or due today. |
| Large | The same under **Overdue** and **Today** headings, then **Coming up** (due in the next seven days, with the day) and, where there is still room, **Also open** (everything else that is not done). It uses the room it has. With a short list each title is shown in full, on up to three lines, with a line under it for what the title doesn't say: in progress or blocked, with Claude, its project, how far its checklist has got. As the list grows the small print goes, and then the first tasks keep a second line for as long as there is room. A long list is one line a task, as many as the text size allows, with a count of the rest. |
| Lock screen | The count and the first two tasks. |

**Habits.** Each habit has a round button that checks it in without opening the app: its next time of day, or for a habit counted in weeks, today's visit. Tapping a habit's name opens it.

| Size | Shows |
| --- | --- |
| Small | The next habit to do, with its streak and its button, and how many more there are. |
| Medium, large | How many are left today, then three habits (medium) or seven (large): what is still to do, soonest first, then what is done. Each has how today stands, its streak and its button. |
| Lock screen | Rectangular: how many are left and the next two. Circular: a ring of today's progress around the number left. Inline, beside the date: how many are left. These have no button. |

- **What the button does.** The check-in is saved on the iPhone first, so the widget shows it at once and nothing is lost. Then the widget tries for a few seconds to send it to the Mac itself. If the Mac can't be reached in that time, the app sends it the next time it runs (when you open it, or when iOS wakes it to refresh). Either way it is recorded once, with the time of the tap.
- The reminder for that time of day, and its second reminder, are taken away as soon as the button is tapped.
- The button only checks in. To take a check-in back, or to log yesterday, open the app.
- A widget drawn before the habit's day turned over (3 AM unless you changed it) checks in the day it was showing, as long as that day can still be logged.

**Habit Year.** A dot for every day of the year, January 1 at the top left, twenty to a row on the large size. A day is lit when every habit that asked for something that day was done, fainter when some of it was, and dim when none of it was; the days before your habits began are fainter still. A rest day asks nothing, and a habit counted in weeks asks nothing of any one day: a gym visit lights a day only when nothing else was asked of it. Today is the orange dot, a ring until everything is done and filled once it is. The days to come are dim. The top line says how many days were done in full, out of the days so far that asked for something. Tapping it opens the Habits tab.

| Size | Shows |
| --- | --- |
| Medium, large | The year. |
| Lock screen | Circular: how many days in a row everything was done. Rectangular: the last eight weeks as columns of dots (Monday at the top), with the run of days and the count for the year. Inline: both, in a line. |

The run of days counts back from today, which counts once it is done; a day that asked nothing, or yesterday while it can still be logged, neither breaks it nor adds to it. It starts again on January 1. How each day went comes from the Mac: the app asks for the year so far once a day, or when there is a new habit, and keeps it on the iPhone, so the widget works without a connection. Today and yesterday come from the habits as they stand on the iPhone, so a check-in shows at once.

Large is the biggest size iOS offers on an iPhone: it takes four of a page's six rows of icons. iOS gives neither an app nor a Mac a way to put a widget on the home screen for you.

If an update adds a size and a widget that was already on the home screen won't take it (it flashes and goes back to the size it had), remove that widget and add it again, or restart the iPhone. iOS keeps the old list of sizes for a widget that is already placed until the home screen restarts. Seen on iOS 26 when the large size was added.

The widgets read what is kept on the iPhone, with your waiting changes applied, so they show what the app shows. Due Today and Habit Year do not contact the Mac at all; Habits does only to send a check-in made with its button. They update when the app does, after a tap on a button, and when the day turns over (midnight for tasks, the habit's day start for habits).

### Shortcuts, Siri and the Action button

The app adds two actions to Shortcuts.

**Add Task** takes one line, read exactly like quick capture.

- **Siri:** "Add a task in Todos", then say the task.
- **Action button:** Settings → Action Button → Shortcut → choose **Add Task** under Todos.
- **Shortcuts:** use **Add Task** in any shortcut, for example after **Dictate Text**.

If the Mac can't be reached, the line is saved on the iPhone and added later, and the answer says so. This replaces the Shortcut described in the main README that calls the Mac directly, and unlike that one it needs no token in the shortcut.

**Log Habit** checks in a habit. It takes the habit, chosen from the ones on this iPhone, and optionally a time of day by name ("Evening"); left empty, it is whichever is still to do.

- **Siri:** "Log Brush teeth in Todos" or "Check in Floss in Todos"; "Log a habit in Todos" asks which.
- **Automations:** use **Log Habit** in a personal automation in the Shortcuts app, for example **When I finish a workout → Log Gym**, or when you arrive somewhere.
- The answer says how the day stands and the streak ("That's today done, and 12 days in a row"), or that the habit was already done. If the Mac can't be reached, the check-in is kept on the iPhone and sent later, and the answer says so.
- The Mac keeps where each check-in came from: these are recorded with the source `shortcut`, the widget's with `widget`, a reminder's **Done** with `notification`.

### Share sheet

In Safari or any app, tap **Share → Todos** to make a task from a link or some text. A link becomes the task's notes, under the page's title; you can edit both before adding. The task is added as written, not read as a quick-capture line, so a title containing "fri" or "#3" stays as it is. (If Todos isn't in the row of apps, tap **More** and turn it on.)

### If it can't connect

The app says what is wrong and what to do:

| It says | What it means |
| --- | --- |
| Tailscale isn't connected | Open the Tailscale app on the iPhone and connect. |
| Can't reach your Mac | The Mac is asleep, off, or not on Tailscale. |
| Todos isn't running on your Mac | Tailscale answered, but the Todos app isn't open there. |
| Remote access is off | Turn on Allow Access from My Other Devices on the Mac. |
| Different Tailscale account | The iPhone is signed in to Tailscale as someone other than the Mac's owner. |
| Access token no longer works | The token was rotated on the Mac. Pair again. |
| Todos on your Mac is out of date | The Mac needs Todos 1.5 or later. |
| This app is out of date | The Mac's Todos speaks a later API version. Install a newer build of this app. |

### When the Mac changed the same task

A change of yours is never applied over someone else's, and never dropped without you choosing.

- If the Mac (you, or a Claude session) changed **different parts** of the task, both changes are kept. You see nothing but the result. Tags combine: both sides' additions and removals apply. Comments, subtasks and completing a task never conflict.
- If you both changed **the same part** differently (the title, say), the Mac's version stays, the rest of your change still goes through, and the part that overlaps waits for you. The task and the Sync screen show **needs your decision**; there you see your version and the Mac's side by side, with who changed it, and pick one for each part. For notes you can also keep both.
- If you **deleted** a task that had changed on the Mac, it is not deleted until you say "Delete Anyway".
- If the task was **deleted on the Mac**, your change is kept and you can put the task back with it, or discard the change.
- Later changes to that same task wait until you decide, so nothing is applied out of order.

## Tests

```bash
ios/scripts/test.sh
```

That runs two things:

1. **TodosKit** with `swift test`, on the Mac. The unit tests cover the API client, version checks, live-update parsing, pairing codes, connection diagnosis, list grouping, Markdown, the list kept on disk, the queue of changes and its replay, conflict detection and merging, and habits: what the Mac sends, what is sent back, the habit day across time zones and clock changes, the phone's own reckoning, the reminder schedule and its limit of 64, and a check-in made from the widget (saved first, sent if it can be, never twice). The integration tests start a real Todos server (`ios/scripts/test-server.mjs`, the Mac app's own server code) and cover CRUD, quick capture, live updates, conflicts, a revoked token, remote access being off and the wrong Tailscale account. They also cover offline use: an edit made offline while the Mac edits the same task ends with nothing lost, a line captured offline is read as of when it was typed and added once even if sent twice, and changes keep waiting through a rotated token or an unreachable Mac. For habits, they hold the phone's own reckoning to the Mac's: the phone is given what the Mac said on some day, makes check-ins "offline" over the days and weeks that follow, and at each point its answer (today, yesterday, the streak, what is at risk) must be what the real server says at that same moment once those changes reach it. The server's clock is pinned for each question, so the days are whatever the test says.
2. **The app's tests** in the iOS Simulator: Keychain storage (including the group shared with the share extension), pairing, opening with no connection, changes made offline and sent later, conflicts and how they are settled, unpairing, tasks added by a Shortcut or the share sheet, what the widget and reminders are given, and habits: checking in with and without a connection, taking a check-in back, rest days, a Mac too old to have habits, making and changing a habit, the Done and Snooze buttons on a reminder, reminders cancelled by a check-in, the Log Habit action, and the app picking up a check-in the widget made.

The integration tests never touch your real list. The server they start uses a data directory created fresh in the system's temporary folder and deleted afterwards, with its own access token.

Run one half only with `ios/scripts/test.sh --kit` or `ios/scripts/test.sh --app`. The Mac app's own tests are `npm test` at the top of the repository.

### Trying it in the Simulator

```bash
ios/scripts/simulator.sh
```

This runs the app in the iOS Simulator against the same throwaway server the integration tests use, already paired, so you can try things without your real list. Lines you type into the terminal are sent to the server as commands that play the part of the Mac (a change in the app, a comment from a Claude session, a rotated token, going out of reach and coming back); the script's header lists them. The Simulator has no camera, so the app offers only the typed-in pairing there.

## Security notes

- The app only connects over **HTTPS**. An `http://` address is refused when pairing, and there are no App Transport Security exceptions. The one exception is for development: the integration tests, and debug builds launched by `simulator.sh`, reach the test server at `http://127.0.0.1`, an address on the same machine that App Transport Security does not cover. Release builds, which is what `install.sh` puts on the iPhone, contain no way to do that.
- The token is never put in an address, a log or a file. Logs record what happened (which request failed, and how) and never task content.
- Nothing is cached by the networking layer: no cookies, no URL cache.
- The copy of the list and the changes waiting to be sent are files in the app's own app-group container. iOS encrypts them with the device's passcode; they can be read once the iPhone has been unlocked after a restart. Each Mac has its own folder, so pairing with a different Mac never shows the first one's list. **Unpair This iPhone** deletes them.
- The pairing QR code carries the token itself. The Mac shows it only in its own window, leaves that window out of screenshots and screen sharing, and closes it after a minute.
- The share extension sends what it adds, so it needs the token. The app and that extension share one Keychain group (`N3366NR59J.com.abhishekpratapa.todos.shared`); nothing else can read it. The widget extension is in that group as well, since the Habits widget's button sends a check-in. That is the only request it makes: it reads nothing from the Mac, and the Due Today widget never uses the network.
- Reminder notifications show a task's title on the lock screen, like any notification. iOS's own notification settings for Todos control that.
- No signing keys, certificates or provisioning profiles are in the repository; `.gitignore` keeps them out. The team identifier in the project file is not a secret.
