# Todos for iPhone

A native iPhone app for the list kept by the Todos app on your Mac. The Mac stays the only copy: the iPhone reaches it over your Tailscale tailnet, through the same `/api/v1` any other client uses (`docs/openapi.json`).

It does pairing, the task list and detail, editing, quick capture and live updates, and it keeps working without a connection: the list is kept on the iPhone, and changes made offline are sent when the Mac can be reached again. It also has reminders as notifications on the iPhone, a widget, a Shortcuts action (for Siri and the Action button too) and a share sheet extension.

```
Todos.xcodeproj   the Xcode project (app and its tests)
Todos/            the app: SwiftUI views and AppModel, the state they share
TodosWidget/      the home screen and lock screen widget
TodosShare/       the share sheet extension
TodosTests/       tests that run inside the app: Keychain storage, pairing, offline use
TodosKit/         a Swift package with everything that has no user interface:
                  the API client, live updates, pairing codes, Keychain storage,
                  the list kept on disk, the queue of changes and how it is sent
                  and merged, version checks, connection diagnosis, Markdown
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

### Reminders on the iPhone

Turn on **Settings → Reminders on This iPhone** in the app (the gear at the top left) and allow notifications when iOS asks. From then on, every reminder in your list is scheduled on the iPhone itself, so it arrives even when your Mac is asleep or out of reach. Tapping one opens its task.

- Reminders are scheduled from the list the iPhone has. One set on the Mac reaches the phone the next time the app updates: at once if the app is open, otherwise when iOS next gives it a background refresh (iOS decides when; opening the app always does it).
- To be reminded only once, turn off **Todos → Reminder Notifications on This Mac** on the Mac. Each device has its own switch, so you choose where reminders appear.
- iOS keeps at most 64 pending notifications for an app, so the 60 soonest are scheduled and the rest follow as those fire.

### Widget

Touch and hold the home screen, tap **Edit → Add Widget**, choose **Todos**, swipe to the size you want and tap **Add Widget**. Tapping a task in the widget opens it.

| Size | Shows |
| --- | --- |
| Small, medium | The count, and the first three or four tasks that are overdue or due today. |
| Large | The same under **Overdue** and **Today** headings, then **Coming up** (due in the next seven days, with the day) and, where there is still room, **Also open** (everything else that is not done). It fits as many lines as the text size allows and says how many tasks were left out. |
| Lock screen | The count and the first two tasks. |

Large is the biggest size iOS offers on an iPhone: it takes four of a page's six rows of icons. iOS gives neither an app nor a Mac a way to put a widget on the home screen for you.

If an update adds a size and a widget that was already on the home screen won't take it (it flashes and goes back to the size it had), remove that widget and add it again, or restart the iPhone. iOS keeps the old list of sizes for a widget that is already placed until the home screen restarts. Seen on iOS 26 when the large size was added.

The widget reads the list kept on the iPhone, with your waiting changes applied, so it shows what the app shows. It does not contact the Mac itself: it updates when the app does, and at midnight.

### Shortcuts, Siri and the Action button

The app adds an **Add Task** action to Shortcuts. It takes one line, read exactly like quick capture.

- **Siri:** "Add a task in Todos", then say the task.
- **Action button:** Settings → Action Button → Shortcut → choose **Add Task** under Todos.
- **Shortcuts:** use **Add Task** in any shortcut, for example after **Dictate Text**.

If the Mac can't be reached, the line is saved on the iPhone and added later, and the answer says so. This replaces the Shortcut described in the main README that calls the Mac directly, and unlike that one it needs no token in the shortcut.

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

1. **TodosKit** with `swift test`, on the Mac. The unit tests cover the API client, version checks, live-update parsing, pairing codes, connection diagnosis, list grouping, Markdown, the list kept on disk, the queue of changes and its replay, and conflict detection and merging. The integration tests start a real Todos server (`ios/scripts/test-server.mjs`, the Mac app's own server code) and cover CRUD, quick capture, live updates, conflicts, a revoked token, remote access being off and the wrong Tailscale account. They also cover offline use: an edit made offline while the Mac edits the same task ends with nothing lost, a line captured offline is read as of when it was typed and added once even if sent twice, and changes keep waiting through a rotated token or an unreachable Mac.
2. **The app's tests** in the iOS Simulator: Keychain storage (including the group shared with the share extension), pairing, opening with no connection, changes made offline and sent later, conflicts and how they are settled, unpairing, tasks added by a Shortcut or the share sheet, and what the widget and reminders are given.

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
- The share extension sends what it adds, so it needs the token. The app and that extension share one Keychain group (`N3366NR59J.com.abhishekpratapa.todos.shared`); nothing else can read it. The widget has no access to the token and never uses the network.
- Reminder notifications show a task's title on the lock screen, like any notification. iOS's own notification settings for Todos control that.
- No signing keys, certificates or provisioning profiles are in the repository; `.gitignore` keeps them out. The team identifier in the project file is not a secret.
