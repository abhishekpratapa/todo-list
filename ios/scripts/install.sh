#!/bin/bash
# Builds Todos for iPhone, signs it, installs it on your iPhone and opens it.
#
#   ios/scripts/install.sh                                   the one iPhone that is connected
#   TODOS_DEVICE="My iPhone" ios/scripts/install.sh          a particular one, by name or identifier
#
# Signing is automatic: xcodebuild creates or renews the development certificate
# and provisioning profile as needed, and registers the iPhone the first time.
# One-time setup is in ios/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE_ID=com.abhishekpratapa.todos.ios

list=$(mktemp)
trap 'rm -f "$list"' EXIT
xcrun devicectl list devices --json-output "$list" > /dev/null
udid=$(node -e '
  const { result } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const want = process.env.TODOS_DEVICE;
  const phones = (result.devices || []).filter((d) => d.hardwareProperties?.deviceType === "iPhone" && d.hardwareProperties?.reality === "physical");
  const named = (d) => [d.deviceProperties?.name, d.identifier, d.hardwareProperties?.udid].includes(want);
  const reachable = (d) => d.connectionProperties?.tunnelState !== "unavailable";
  const found = phones.filter(want ? named : reachable);
  const describe = (d) => `  ${d.deviceProperties?.name} (${d.connectionProperties?.tunnelState})`;
  if (found.length !== 1) {
    console.error(found.length ? "More than one iPhone is connected. Set TODOS_DEVICE to one of:" : "No connected iPhone found. Unlock it, connect it by cable (or to the same Wi-Fi), and trust this Mac. Known iPhones:");
    console.error((found.length ? found : phones).map(describe).join("\n") || "  (none)");
    process.exit(1);
  }
  console.log(found[0].hardwareProperties.udid);
' "$list")

echo "== Building and signing"
xcodebuild -project Todos.xcodeproj -scheme Todos -configuration Release \
  -destination "platform=iOS,id=$udid" -derivedDataPath build \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  -quiet build

echo "== Installing"
xcrun devicectl device install app --device "$udid" build/Build/Products/Release-iphoneos/Todos.app

echo "== Opening"
xcrun devicectl device process launch --device "$udid" "$BUNDLE_ID"
