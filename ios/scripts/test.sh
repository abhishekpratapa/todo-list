#!/bin/bash
# Runs every test for the iPhone app.
#
#   1. TodosKit with `swift test`, on this Mac: the unit tests, and the integration
#      tests, which start a real Todos server (ios/scripts/test-server.mjs) on a
#      temporary data directory. Your real list is never touched.
#   2. The app's own tests in the iOS Simulator: Keychain storage, pairing, changes.
#
# Pass --kit or --app to run only one of them.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--app" ]]; then
  echo "== TodosKit: unit and integration tests"
  (cd TodosKit && swift test)
fi

if [[ "${1:-}" != "--kit" ]]; then
  echo "== App tests in the iOS Simulator"
  simulator=$(xcrun simctl list devices available --json | node -e '
    let text = "";
    process.stdin.on("data", (c) => (text += c)).on("end", () => {
      const runtimes = Object.entries(JSON.parse(text).devices).filter(([name]) => name.includes("iOS")).sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }));
      const phone = runtimes.flatMap(([, devices]) => devices).find((d) => d.name.startsWith("iPhone"));
      if (!phone) { console.error("No iPhone simulator is installed. Install one in Xcode > Settings > Components."); process.exit(1); }
      console.log(phone.udid);
    });
  ')
  # xcodebuild says a great deal; show the test results and anything that went wrong.
  xcodebuild test -project Todos.xcodeproj -scheme Todos \
    -destination "platform=iOS Simulator,id=$simulator" -derivedDataPath build 2>&1 \
    | grep -E "^(✔|✘|◇ Test run)|error:|\*\* TEST (SUCCEEDED|FAILED) \*\*|Testing failed"
fi
