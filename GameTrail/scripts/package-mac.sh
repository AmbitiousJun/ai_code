#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
node_bin="${GAMETRAIL_NODE:-$(command -v node)}"
"$node_bin" -e 'if(Number(process.versions.node.split(".")[0])<24) throw Error("需要 Node 24+")'
export PLAYWRIGHT_BROWSERS_PATH=0
"$node_bin" node_modules/playwright/cli.js install chromium webkit
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
app="$build_dir/GameTrail.app"
resources="$app/Contents/Resources"
mkdir -p "$app/Contents/MacOS" "$resources/native" dist
cp "$node_bin" "$resources/node"
cp -R src ui node_modules "$resources/"
swiftc -module-cache-path "$build_dir/swift-cache" -O native/vision.swift -o "$resources/native/vision"
swiftc -module-cache-path "$build_dir/swift-cache" -O native/launcher.swift -o "$app/Contents/MacOS/GameTrail"
cp native/GameTrail.icns "$resources/"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.gametrail.workbench</string>
<key>CFBundleName</key><string>GameTrail</string>
<key>CFBundleExecutable</key><string>GameTrail</string>
<key>LSUIElement</key><true/>
<key>CFBundleIconFile</key><string>GameTrail.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.1</string>
<key>CFBundleVersion</key><string>2</string>
</dict></plist>
PLIST
ditto -c -k --keepParent "$app" "dist/GameTrail-0.1.1-macOS-$(uname -m).zip"
