# Todos for iPhone

A native iPhone app for the list kept by the Todos app on your Mac. The Mac stays the only copy: the iPhone reaches it over your Tailscale tailnet, through the same `/api/v1` any other client uses (`docs/openapi.json`).

This is the online client (phase 1): pairing, the task list and detail, editing, quick capture and live updates. It needs the Mac to be reachable. Offline use, notifications, a widget and Shortcuts come in later phases.

```
Todos.xcodeproj   the Xcode project (app and its tests)
Todos/            the app: SwiftUI views and AppModel, the state they share
TodosTests/       tests that run inside the app: Keychain storage, pairing, changes
TodosKit/         a Swift package with everything that has no user interface:
                  the API client, live updates, pairing codes, Keychain storage,
                  version checks, connection diagnosis, the Markdown parser
scripts/          install.sh, test.sh, simulator.sh, and the Todos server the tests run against
```

There are no third-party dependencies.

## What you need

- A Mac with **Xcode 16 or later** and Node.js (which the Mac app's own development already needs).
- A paid Apple Developer account, signed in under **Xcode → Settings → Accounts**. The project signs automatically with team `N3366NR59J`.
- An iPhone on **iOS 18 or later**, with the **Tailscale** app connected to the same tailnet and account as the Mac.
- **Todos 1.5 or later** on the Mac, with **Remote Access** on (Todos → Remote Access → Allow Access from My Other Devices). The app checks this when it connects and says so if the Mac's Todos is too old.

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

This builds the app, signs it, installs it on the connected iPhone and opens it. Signing is automatic: the first run registers the iPhone with your developer account and creates a development provisioning profile, and later runs reuse them.

An installed build stops opening when that profile expires, which is when your Apple Development certificate does (at most a year after it was issued). Running the script again renews both and puts a fresh build on the phone. To see the date:

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
- **Start with Claude** is only in the Mac app, so it isn't shown here. You can still assign a task to Claude.
- Your changes appear in a task's history on the Mac as "You · iPhone".

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

If the Mac changes a task at the same moment you do, your change is not applied over it and is not dropped either: the app shows the Mac's version and asks whether to apply yours on top.

## Tests

```bash
ios/scripts/test.sh
```

That runs two things:

1. **TodosKit** with `swift test`, on the Mac. The unit tests cover the API client, version checks, live-update parsing, pairing codes, connection diagnosis, list grouping and Markdown. The integration tests start a real Todos server (`ios/scripts/test-server.mjs`, the Mac app's own server code) and cover CRUD, quick capture, live updates, conflicts, a revoked token, remote access being off and the wrong Tailscale account.
2. **The app's tests** in the iOS Simulator: Keychain storage, pairing, changes, and what happens when the Mac can't be reached.

The integration tests never touch your real list. The server they start uses a data directory created fresh in the system's temporary folder and deleted afterwards, with its own access token.

Run one half only with `ios/scripts/test.sh --kit` or `ios/scripts/test.sh --app`. The Mac app's own tests are `npm test` at the top of the repository.

### Trying it in the Simulator

```bash
ios/scripts/simulator.sh
```

This runs the app in the iOS Simulator against the same throwaway server the integration tests use, already paired, so you can try things without your real list. Lines you type into the terminal are sent to the server as commands that play the part of the Mac (a change in the app, a comment from a Claude session, a rotated token); the script's header lists them. The Simulator has no camera, so the app offers only the typed-in pairing there.

## Security notes

- The app only connects over **HTTPS**. An `http://` address is refused when pairing, and there are no App Transport Security exceptions. The one exception is for development: the integration tests, and debug builds launched by `simulator.sh`, reach the test server at `http://127.0.0.1`, an address on the same machine that App Transport Security does not cover. Release builds, which is what `install.sh` puts on the iPhone, contain no way to do that.
- The token is never put in an address, a log or a file. Logs record what happened (which request failed, and how) and never task content.
- Nothing is cached by the networking layer: no cookies, no URL cache.
- The pairing QR code carries the token itself. The Mac shows it only in its own window, leaves that window out of screenshots and screen sharing, and closes it after a minute.
- No signing keys, certificates or provisioning profiles are in the repository; `.gitignore` keeps them out. The team identifier in the project file is not a secret.
