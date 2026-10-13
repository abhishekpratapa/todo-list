# Remote access: what is protected, and what isn't

Todos keeps your list in one file on your Mac. Remote access lets your other devices reach the app over your Tailscale tailnet. This note describes the design and its limits. The behaviour described here is covered by the tests in `test/`.

## How it is exposed

- The server listens on `127.0.0.1` only, always. It is never bound to a network interface.
- Other devices reach it through `tailscale serve`, which accepts HTTPS connections from your tailnet and relays them to the local server. Tailscale provides the encryption and the certificate.
- Remote access is **off by default**. While it is off the server behaves as it did in 1.3.0, with one addition: any request that carries proxy headers is refused, so a serve mapping left in place can't reach a server that has no sign-in. A test runs the real 1.3.0 server next to the current one and compares their answers.
- Requests that came through **Tailscale Funnel** (the public internet) are refused, and the app warns if Funnel is enabled for the address.

## What every request must pass when remote access is on

Because `tailscale serve` delivers everything from `127.0.0.1`, where a request appears to come from decides nothing. Every request is checked the same way, including ones made on the Mac:

1. **Host.** It must be `127.0.0.1`/`localhost` for a direct request, or this Mac's tailnet name for a relayed one. This blocks DNS rebinding.
2. **Tailscale account** (optional, on by default). A relayed request must come from the Mac owner's own Tailscale account. Tailscale sets this header itself and overwrites anything a client sends. If the owner can't be determined, relayed requests are refused.
3. **Authentication.** A bearer token, or a session cookie obtained by signing in with the token. Only the health check (which says `{"status":"ok"}` and nothing else), the sign-in page and its assets work without it.
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

- **Start a Claude session**, or anything else that runs a program on the Mac. That route answers only the app's own windows. It is refused for every other session, including a browser on the Mac that signed in with the token.
- **See local paths**: the data file's location and the folders used for Start with Claude are only shown to the app's own windows.
- The API has no endpoint that reads files, changes settings, or returns the token.

## Conflicts

Every task has a revision number that goes up with each change, whoever makes it. An edit or delete through the API must name the revision it is based on; if the task has changed since, the edit is refused with the current task rather than applied. The dashboard does the same for edits that replace a value. All writers (app, API, MCP server) go through one store and one file lock.

## What this does not protect against

- **Anyone who has both the token and a device on your tailnet under your account** has full read and write access to your list, including delete. Treat the token like a password.
- **Someone who photographs the pairing code** while it is on screen has the token. Rotate it if that might have happened.
- **Other programs running as you on the Mac.** They can read the token file and the data file directly, as they always could read the data file. They can also send local requests with made-up Tailscale headers; those headers are used for the account check on relayed traffic and for labelling changes, and are not what grants access. The token is.
- **Device labels are informational.** "You · iPhone" comes from Tailscale's record of the address; the `X-Todos-Client` label is whatever the client says.
- **What you type into a task is shown on the Mac.** A task created remotely can carry a reminder time, which shows a notification on the Mac, and its title appears in the menu bar. Notes are rendered through a renderer that escapes HTML and only links to http, https and mailto addresses.
- **A session cookie stays valid until it expires or the token is rotated**, because sessions aren't stored server-side.
- **Availability.** The server runs only while the app runs and the Mac is awake. A browser on another device shows nothing without it. The iPhone app keeps its own copy of the list to read and change offline, and sends its changes when the Mac is reachable again.
- **The iPhone app's copy.** That copy (tasks, notes, comments) and any changes waiting to be sent are stored on the iPhone, protected by its passcode and removed when the iPhone is unpaired in the app. Rotating the token stops the iPhone reaching the Mac; it does not erase what the iPhone already has.
- **Tailscale itself.** Encryption in transit, device identity, and who is on your tailnet are Tailscale's job. If your tailnet's access rules let other people's devices reach this Mac, the account check and the token are what stand between them and your list.
- The MCP server is not exposed over the network. Claude sessions on other machines can't use the list in this version.
