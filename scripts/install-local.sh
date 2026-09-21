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

# Electron reads ELECTRON_RUN_AS_NODE before a line of our code runs: with it set, the app binary
# IS a Node interpreter, and given no script to run it drops into a REPL. The install then fails
# at "verify it boots" with a Node banner where the smoke report should be — which looks like the
# app is broken and is not. The variable leaks easily, since anything that shells out to Electron
# as Node can leave it behind, so drop it rather than trusting whatever launched this.
if [ -n "${ELECTRON_RUN_AS_NODE:-}" ]; then
  echo "==> ignoring ELECTRON_RUN_AS_NODE=${ELECTRON_RUN_AS_NODE} inherited from the environment"
  unset ELECTRON_RUN_AS_NODE
fi

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
sleep 2

echo "==> install to ${DEST}"
# LaunchServices caches a bundle's code identity per path. Replacing an app in place leaves the
# old registration behind, and it then refuses to launch the new one: `open` returns success, the
# process dies before main, and the only clue is
# `codesign_util.cc: task_name_for_pid: (os/kern) failure (5)` on stderr. Running the binary
# directly still works throughout, which is what makes it so confusing. Unregister first,
# register again afterwards.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREGISTER" ] && "$LSREGISTER" -u "$DEST" 2>/dev/null || true

rm -rf "$DEST"
ditto "$SRC" "$DEST"            # NOT cp -R: plain cp corrupts a signed bundle
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
# NOT codesign --deep.
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$DEST" 2>/dev/null || true

echo "==> verify it boots"
# Retry once: the copy that was just quit can still be tearing down, and a second instance
# starting into that raced often enough to make a healthy build look broken.
SMOKE_LOG=$(mktemp)
smoke_ok=0
for attempt in 1 2; do
  : >"$SMOKE_LOG"
  # Bounded: a smoke run that never exits would hang the install with no output at all, which
  # is exactly how this script wedged once.
  if command -v timeout >/dev/null; then
    ONESTOP_SMOKE=1 timeout 90 "$DEST/Contents/MacOS/${APP_NAME}" >"$SMOKE_LOG" 2>&1 || true
  else
    ONESTOP_SMOKE=1 "$DEST/Contents/MacOS/${APP_NAME}" >"$SMOKE_LOG" 2>&1 || true
  fi
  if grep -qE '\[smoke\]' "$SMOKE_LOG"; then smoke_ok=1; break; fi
  echo "   attempt $attempt produced no smoke report; retrying"
  sleep 3
done
if [ "$smoke_ok" -ne 1 ]; then
  echo "the packaged app never produced a smoke report:" >&2
  grep -viE 'INFO:|WARNING:' "$SMOKE_LOG" | tail -20 >&2
  exit 1
fi
grep -E '\[smoke\]' "$SMOKE_LOG"
rm -f "$SMOKE_LOG"

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
