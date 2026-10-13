#!/bin/bash
# Runs the app in the iOS Simulator against a throwaway Todos server, for trying
# things out without your Mac's real list or token.
#
# It starts ios/scripts/test-server.mjs (the Mac app's own server code, on a data
# directory in the temporary folder), builds the app, and launches it already
# paired with that server. Debug builds accept this pairing through two environment
# variables; release builds, like the one on your iPhone, have no such door.
#
# While it runs, each line you type is sent to the server as a command, which is
# how to play the part of the Mac. For example:
#
#   {"cmd":"mac.create","input":{"title":"Added on the Mac","due":"tomorrow"}}
#   {"cmd":"mac.update","id":1,"patch":{"comment":"On it."},"by":"Claude Code · repo"}
#   {"cmd":"listening","on":false}      (the Mac goes out of reach; "on":true brings it back)
#   {"cmd":"rotate"}
#
# Press Control-C to stop the server. Its data is deleted.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE_ID=com.abhishekpratapa.todos.ios
simulator=$(xcrun simctl list devices available --json | node -e '
  let text = "";
  process.stdin.on("data", (c) => (text += c)).on("end", () => {
    const runtimes = Object.entries(JSON.parse(text).devices).filter(([name]) => name.includes("iOS")).sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }));
    const phones = runtimes.flatMap(([, devices]) => devices).filter((d) => d.name.startsWith("iPhone"));
    const phone = phones.find((d) => d.state === "Booted") || phones[0];
    if (!phone) { console.error("No iPhone simulator is installed. Install one in Xcode > Settings > Components."); process.exit(1); }
    console.log(phone.udid);
  });
')

work=$(mktemp -d)
mkfifo "$work/commands"
node scripts/test-server.mjs < "$work/commands" > "$work/replies" &
server=$!
exec 3> "$work/commands" # keeps the server's input open until this script ends
replies=
trap 'exec 3>&-; kill "$server" $replies 2> /dev/null; rm -rf "$work"' EXIT

until [ -s "$work/replies" ]; do sleep 0.1; done
port=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").split("\n")[0]).port)' "$work/replies")
token=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").split("\n")[0]).token)' "$work/replies")

echo "== Building"
xcodebuild build -project Todos.xcodeproj -scheme Todos -configuration Debug \
  -destination "platform=iOS Simulator,id=$simulator" -derivedDataPath build -quiet

echo "== Starting the Simulator"
xcrun simctl bootstatus "$simulator" -b > /dev/null
# The window that shows the simulator: Simulator.app up to Xcode 26, Device Hub from Xcode 27.
developer=$(xcode-select -p)
for viewer in "$developer/Applications/Simulator.app" "$developer/../Applications/DeviceHub.app"; do
  if [ -d "$viewer" ]; then
    open "$viewer"
    break
  fi
done
xcrun simctl install "$simulator" build/Build/Products/Debug-iphonesimulator/Todos.app
SIMCTL_CHILD_TODOS_TEST_PORT=$port SIMCTL_CHILD_TODOS_TEST_TOKEN=$token \
  xcrun simctl launch --terminate-running-process "$simulator" "$BUNDLE_ID" > /dev/null

echo "== Running against a test server on port $port. Type a command, or press Control-C to stop."
tail -n +2 -f "$work/replies" &
replies=$!
disown "$replies"
while IFS= read -r line; do
  [ -n "$line" ] && printf '%s\n' "$line" >&3
done
