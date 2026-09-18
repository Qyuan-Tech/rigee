#!/usr/bin/env bash
# Build onestop and install it into /Applications, then prove it actually launches.
#
#   ./scripts/install-local.sh
#
# Exists because installing this by hand went wrong twice, in ways that were painful to diagnose:
#
#   cp -R breaks a signed app bundle. macOS bundles carry metadata that plain cp does not
#   faithfully reproduce, and Electron validates its own bundle at startup (Info.plist holds an
#   ElectronAsarIntegrity SHA256 of app.asar). The copy then fails before main runs: no window,
#   no stdout, and only `codesign_util.cc: task_name_for_pid: (os/kern) failure (5)` on stderr,
#   which points nowhere useful. `ditto` is the tool for this.
#
#   `codesign --force --deep --sign -` makes it worse. --deep is deprecated and signs Electron's
#   nested helper bundles in an order Electron rejects. electron-builder already leaves the bundle
#   launchable; on Intel macOS an unsigned app runs once quarantine is cleared.
#
# The sharp edge both times: the app runs fine when the binary is invoked directly, and only fails
# when launched through LaunchServices. Always verify with `open`.

set -euo pipefail
cd "$(dirname "$0")/.."

[ "$(uname)" = "Darwin" ] || { echo "macOS only; use pnpm pack:linux / pack:win elsewhere" >&2; exit 1; }

ARCH_FLAG="--x64"
[ "$(uname -m)" = "arm64" ] && ARCH_FLAG="--arm64"

VERSION=$(node -p "require('./package.json').version")
APP_NAME=$(node -p "require('./package.json').productName || require('./package.json').name")
DEST="/Applications/${APP_NAME}.app"

echo "==> build"
pnpm run build

echo "==> package ($ARCH_FLAG)"
pnpm exec electron-builder --mac --dir "$ARCH_FLAG" --publish never >/dev/null

SRC="release/${VERSION}/mac/${APP_NAME}.app"
[ -d "$SRC" ] || SRC="release/${VERSION}/mac-arm64/${APP_NAME}.app"
[ -d "$SRC" ] || { echo "cannot find the packaged app under release/${VERSION}" >&2; exit 1; }

echo "==> quit any running copy"
osascript -e "quit app \"${APP_NAME}\"" 2>/dev/null || true
sleep 1
pkill -f "${APP_NAME}.app/Contents/MacOS/${APP_NAME}" 2>/dev/null || true
sleep 1

echo "==> install to ${DEST}"
rm -rf "$DEST"
ditto "$SRC" "$DEST"            # NOT cp -R
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
# NOT codesign --deep.

echo "==> verify it boots"
ONESTOP_SMOKE=1 "$DEST/Contents/MacOS/${APP_NAME}" 2>&1 | grep -E '\[smoke\]' || {
  echo "the packaged app did not pass its smoke check" >&2; exit 1; }

echo "==> verify it launches through LaunchServices"
ERRLOG=$(mktemp)
open -n -a "$DEST" --stderr "$ERRLOG"
sleep 6
if ! pgrep -f "${APP_NAME}.app/Contents/MacOS/${APP_NAME}" >/dev/null; then
  echo "launched via open but exited immediately. stderr:" >&2
  grep -viE 'INFO:|WARNING:' "$ERRLOG" | head -10 >&2
  exit 1
fi
rm -f "$ERRLOG"

echo
echo "installed and running: $DEST"
