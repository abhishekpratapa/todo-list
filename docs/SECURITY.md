# Remote access and the local socket: what is protected, and what isn't

Todos keeps your list in one file on your Mac. Remote access lets your other devices reach the app over your Tailscale tailnet. The local socket lets the `todos` command reach it on the Mac itself. This note describes the design of both and their limits. The behaviour described here is covered by the tests in `test/`.

## How it is exposed

- The server listens on `127.0.0.1` only, always. It is never bound to a network interface.
- Other devices reach it through `tailscale serve`, which accepts HTTPS connections from your tailnet and relays them to the local server. Tailscale provides the encryption and the certificate.
- Remote access is **off by default**. While it is off the server behaves as it did in 1.3.0, with one addition: any request that carries proxy headers is refused, so a serve mapping left in place can't reach a server that has no sign-in. A test runs the real 1.3.0 server next to the current one and compares their answers.
- Requests that came through **Tailscale Funnel** (the public internet) are refused, and the app warns if Funnel is enabled for the address.

## What every request must pass when remote access is on

Because `tailscale serve` delivers everything from `127.0.0.1`, where a request appears to come from decides nothing. Every request is checked the same way, including ones made on the Mac:

1. **Host.** It must be `127.0.0.1`/`localhost` for a direct request, or this Mac's tailnet name for a relayed one. This blocks DNS rebinding.
2. **Tailscale account** (optional, on by default). A relayed request must come from the Mac owner's own Tailscale account. Tailscale sets this header itself and overwrites anything a client sends. If the owner can't be determined, relayed requests are refused.
3. **Authentication.** A bearer token, or a session cookie obtained by signing in with the token. Only the health checks, the sign-in page and its assets work without it. `/api/v1/health` says `{"status":"ok"}` and nothing else. `/health` adds the app's version and the API's version, and nothing about the list (see below).
4. **Origin.** A request that changes anything must come from the app's own origin. There are no CORS headers, so other websites can't call the API, and the cookie is `SameSite=Strict`, so they can't ride on your session.
5. **Limits.** Bodies up to 256 KB, 120 changes a minute per client, 10 wrong tokens per 5 minutes per client, at most 32 live-update connections, and time limits on receiving a request.

## Tokens and sessions

- The access token is 256 random bits, stored in `~/Library/Application Support/Todos/remote-access-token`, readable only by your user (mode 0600). It is created the first time it is needed. It is compared in constant time, and never written to a log or put in a URL.
- A browser exchanges the token once for a session cookie: `HttpOnly` (page scripts can't read it), `SameSite=Strict`, `Secure` over HTTPS, valid 90 days. Cookies are signed with a key derived from the token and are not stored on the Mac.
- **Pairing the iPhone app.** Remote Access → Pair iPhone… shows a QR code holding the address and the access token. The code is drawn inside the app and shown in a window of its own that runs no scripts and loads nothing. The HTTP server has no route that returns the code or the token. The window is excluded from screenshots, recordings and screen sharing, and closes after a minute or as soon as the token is rotated or remote access is switched off. The iPhone app keeps the token in the iOS Keychain (this device only, not synced).
- **Retries are safe.** A change can carry an `Idempotency-Key`; the key is recorded with the change in the task's activity, and a second request with the same key changes nothing. This is what lets the iPhone app resend a change whose answer was lost without adding or applying it twice.
- **Rotating the token** invalidates every session and API client at once. This is the way to revoke a lost device. Signing out on a device only clears that device's cookie.
- The Mac app's own windows use a separate cookie, signed with a key that exists only in the running app's memory. Nothing else can create one, and it is ignored on relayed requests.

## What other devices cannot do

- **Start a Claude session**, or anything else that runs a program on the Mac. The button's route answers only the app's own windows. It is refused for every other session, including a browser on the Mac that signed in with the token. What the `todos` command uses for the same thing is not served on the port at all (see the next section).
- **See local paths**: the data file's location and the folders used for Start with Claude are only shown to the app's own windows, and on the local socket.
- The API has no endpoint that reads files, changes settings, or returns the token.

## The local socket and the `todos` command

While the app runs, its server also listens on a Unix domain socket: `~/Library/Application Support/Todos/todos.sock` (or `~/.todos/todos.sock` when a long home folder would push that path past the 103 bytes a socket's path may have). The `todos` command on the Mac talks to the app through it.

**Who can use it.** Programs running as you, and nobody else. There is no token on the socket: being able to open the file is the authentication.

- The file is created with mode 0600. The permissions are tightened before the file exists, not after, so there is no moment when anyone else could open it.
- It lives in a folder only you can write to. The app refuses to put it in a folder other users can change, where they could swap it for a socket of their own.
- This is the trust the list has always had. A program running as you could already read and change `todos.json` directly.

**It cannot be reached from the network.** A Unix socket has no network address. `tailscale serve` relays to `127.0.0.1:7420`, never to the socket. As a second line, any request on the socket that carries a proxy's headers (`X-Forwarded-*`, `Forwarded`, `Tailscale-*`) is refused, so even if a proxy were pointed at the socket file, what it relays would get nothing.

**It cannot be reached from a web page.** Browsers can't open Unix sockets, so the Host and Origin checks the port needs have nothing to guard against here.

**What it serves.** The health check and `/api/v1`, and nothing else: no dashboard pages, none of the dashboard's own routes, no sign-in. The same store, the same file lock and the same conflict rules apply. Changes made through it are labelled "command line" in a task's activity.

**Local-only operations.** Two routes exist only on the socket: `GET` and `POST /api/v1/tasks/{id}/claude-session`, which the `todos` command uses to start a Claude session on a task.

- The first returns what the app's own Start with Claude button would use: the prompt, the folder remembered for the task's project, the options for `claude`, and where `claude` is on this Mac. The second records that a session was started, and remembers the folder.
- Neither runs anything. The command runs `claude` itself, as you, in your own terminal, exactly as if you had typed it.
- On the port they are answered exactly like a path that does not exist, to every caller: signed in or not, on the Mac or relayed by `tailscale serve`, with remote access on or off. The server decides this by which listener a request arrived on, not by anything in the request, so no header can change it.

**Starting and stopping.** On startup, a socket file left by a copy of the app that did not exit cleanly is replaced, but only after checking that nothing answers on it. One that still answers belongs to a running copy and is left alone. Anything at that path that is not a socket is never removed. Quitting the app removes the file.

**The health check.** `GET /health` answers without sign-in, on the socket and on the port: `status`, the app's version and the API's version, and nothing about your list. The port's other rules still come first. While remote access is off, nothing relayed is answered, the health check included. While it is on, the Host, the Tailscale account and Funnel are checked before it. So a device that gets past those can learn which version of Todos you run without having the token. Before, it could only learn that something answered.

**Starting the app in the background.** `open -g -a Todos --args --background` starts the app with no window. It grants nothing: it is the same app, started by you. Over SSH it only works while you are logged in to the Mac's desktop.

**Install Command Line Tool.** This makes one symbolic link, `~/.local/bin/todos`, pointing at the copy of the command inside the app. It is done as you: no password is asked for and nothing runs as root. It never replaces or removes anything it did not put there. To tell you whether a terminal will find the command, the app reads your shell's startup files and looks for that folder. It does not run them or a shell: anything they did would be done in the app's name, and macOS would then ask whether Todos may read whatever folders they touch. The command inside the app is signed the same way the app is: ad hoc by `npm run dist`; with a Developer ID, the hardened runtime and Apple's notarization by `npm run dist:release`.

## A Mac that uses another Mac's list

A second Mac can use the list on your main Mac instead of its own (Todos → Use Another Mac's List…). It is then one more device with the access token, like the iPhone, and goes through every check above on the main Mac.

**The token.** The second Mac keeps the main Mac's token in `~/Library/Application Support/Todos/host-access-token`, readable only by your user (mode 0600), the same way the main Mac keeps its own. Only the app itself sends it, and only to the address you entered: HTTPS, which `tailscale serve` provides, or plain HTTP to the Mac itself. It is never put in a URL, a log or an answer. Switching back to the Mac's own list deletes it.

**What reaches the main Mac through it.** The second Mac's own server passes requests on to the main Mac, so its window, quick capture and `todos` command work there. Only its own app's windows and its local socket are passed on. Nothing that arrives from elsewhere is, and its Remote Access stays off meanwhile. So the main Mac's list can be read and changed by whatever can already use the second Mac's own list: you, and other programs running as you on the second Mac.

**Claude sessions on it.** They reach the main Mac's list through the second Mac's app, over its socket, and never see the token. Their changes carry `X-Todos-Claude-Session`, which the main Mac records as the change's author ("Claude Code · my-repo") instead of "you". Anyone with the token could send it: like the device labels, it says who did something and grants nothing. Only names that start with "Claude" or "Cowork" are taken; anything else is recorded as yours.

**Reminders.** The main Mac decides when a reminder has been delivered. The second Mac shows it too, if its own switch is on, without marking it delivered there.

**Starting Claude sessions.** On the second Mac, Start with Claude chooses folders on and runs programs on the second Mac, as it would with its own list. The main Mac's local-only routes are not involved: they still answer nothing at its network address.

## Conflicts

Every task has a revision number that goes up with each change, whoever makes it. An edit or delete through the API must name the revision it is based on; if the task has changed since, the edit is refused with the current task rather than applied. The dashboard does the same for edits that replace a value. All writers (app, API, MCP server) go through one store and one file lock.

## What this does not protect against

- **Anyone who has both the token and a device on your tailnet under your account** has full read and write access to your list, including delete. Treat the token like a password.
- **Someone who photographs the pairing code** while it is on screen has the token. Rotate it if that might have happened.
- **Other programs running as you on the Mac.** They can read the token file and the data file directly, as they always could read the data file. They can use the local socket, which asks for no token, and so can see where Start with Claude's folders are. They can also send local requests with made-up Tailscale headers; those headers are used for the account check on relayed traffic and for labelling changes, and are not what grants access. The token is.
- **Other accounts on the Mac** cannot open the socket or read the data file. An administrator who can become you, or read any file, can do what you can.
- **Device labels are informational.** "You · iPhone" comes from Tailscale's record of the address; the `X-Todos-Client` label is whatever the client says.
- **What you type into a task is shown on the Mac.** A task created remotely can carry a reminder time, which shows a notification on the Mac, and its title appears in the menu bar. Notes are rendered through a renderer that escapes HTML and only links to http, https and mailto addresses.
- **A session cookie stays valid until it expires or the token is rotated**, because sessions aren't stored server-side.
- **Availability.** The server runs only while the app runs and the Mac is awake. A browser on another device shows nothing without it. The iPhone app keeps its own copy of the list to read and change offline, and sends its changes when the Mac is reachable again.
- **The iPhone app's extensions.** Its share sheet extension can send new tasks, so it shares the app's Keychain item through a Keychain group only the two of them belong to. Its widget only reads the copy of the list on the phone and has no access to the token.
- **The iPhone app's copy.** That copy (tasks, notes, comments) and any changes waiting to be sent are stored on the iPhone, protected by its passcode and removed when the iPhone is unpaired in the app. Rotating the token stops the iPhone reaching the Mac; it does not erase what the iPhone already has.
- **Tailscale itself.** Encryption in transit, device identity, and who is on your tailnet are Tailscale's job. If your tailnet's access rules let other people's devices reach this Mac, the account check and the token are what stand between them and your list.
- The MCP server is not exposed over the network. Claude sessions on another machine reach the list only from a Mac that uses it through its own Todos app (see above), with the token held by that app.
