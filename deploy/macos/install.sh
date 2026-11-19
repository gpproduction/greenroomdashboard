#!/bin/bash
# GrowPoint Backstage — install as a macOS background service that starts at boot.
#
#   ./deploy/macos/install.sh            install / reinstall
#   ./deploy/macos/install.sh --dry-run  show what would be written, change nothing
#
# Run it as the normal user who owns this folder (not with sudo); it asks for your
# password only for the steps that need admin rights.
set -euo pipefail

LABEL="church.growpoint.greenroom"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_USER="$(id -un)"
PORT="${PORT:-8080}"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

if [[ $DRY_RUN -eq 0 ]]; then
  [[ "$(uname)" == "Darwin" ]] || fail "This installer is for macOS."
  [[ $EUID -ne 0 ]] || fail "Run this as your normal user, not with sudo."
  # macOS privacy protection blocks background services from these folders.
  case "$APP_DIR" in
    "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*|*"/Library/Mobile Documents"*)
      fail "GrowPoint Backstage can't run as a background service from ${APP_DIR} (macOS blocks Documents/Desktop/Downloads/iCloud).
Move the folder to your home folder, e.g.:  mv \"${APP_DIR}\" ~/greenroom  — then run ~/greenroom/deploy/macos/install.sh" ;;
  esac
fi

# --- Node.js ------------------------------------------------------------------
say "Checking Node.js"
NODE_BIN="$(command -v node || true)"
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  [[ -z "$NODE_BIN" && -x "$candidate" ]] && NODE_BIN="$candidate"
done
if [[ -z "$NODE_BIN" ]]; then
  fail "Node.js is not installed. Download the LTS installer from https://nodejs.org, run it, then run this script again."
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || fail "Node.js 20 or newer is required (found $("$NODE_BIN" -v)). Install the LTS from https://nodejs.org."
NPM_BIN="$(dirname "$NODE_BIN")/npm"
echo "Using $NODE_BIN ($("$NODE_BIN" -v))"

# --- dependencies & config ----------------------------------------------------------
if [[ $DRY_RUN -eq 0 ]]; then
  say "Installing app dependencies"
  (cd "$APP_DIR" && "$NPM_BIN" ci --omit=dev --no-audit --no-fund)

  if [[ ! -f "$APP_DIR/.env" ]]; then
    say "Creating .env"
    sed -e "s/^PORT=.*/PORT=${PORT}/" -e 's/^DEMO=.*/DEMO=0/' "$APP_DIR/.env.example" > "$APP_DIR/.env"
    chmod 600 "$APP_DIR/.env"
  fi
  mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
fi

# --- launchd service ------------------------------------------------------------------
PLIST_CONTENT="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>UserName</key><string>${RUN_USER}</string>
  <key>WorkingDirectory</key><string>${APP_DIR}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${APP_DIR}/server/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>DATA_DIR</key><string>${APP_DIR}/data</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${APP_DIR}/logs/greenroom.log</string>
  <key>StandardErrorPath</key><string>${APP_DIR}/logs/greenroom.log</string>
</dict>
</plist>"

if [[ $DRY_RUN -eq 1 ]]; then
  say "Dry run — would write ${PLIST}:"
  echo "$PLIST_CONTENT"
  exit 0
fi

say "Installing background service (you may be asked for your Mac password)"
TMP="$(mktemp)"
echo "$PLIST_CONTENT" > "$TMP"
plutil -lint "$TMP" >/dev/null || fail "Generated service file is invalid."
sudo launchctl bootout "system/${LABEL}" 2>/dev/null || true
sudo install -m 644 -o root -g wheel "$TMP" "$PLIST"
rm -f "$TMP"
sudo launchctl bootstrap system "$PLIST"
sudo launchctl enable "system/${LABEL}"

say "Waiting for GrowPoint Backstage to start"
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then STARTED=1; break; fi
  sleep 1
done
[[ "${STARTED:-0}" -eq 1 ]] || fail "The service did not start. Check ${APP_DIR}/logs/greenroom.log"

# --- keep the Mac awake & recover from power cuts ------------------------------------------
say "Server power settings"
echo "A server Mac should never sleep and should restart by itself after a power cut."
read -r -p "Apply these settings now? (sleep never, auto-restart after power failure) [Y/n] " ans
if [[ ! "$ans" =~ ^[Nn] ]]; then
  sudo pmset -a sleep 0 disksleep 0 autorestart 1 || echo "(Could not change power settings; set them in System Settings → Energy.)"
fi

HOSTNAME_LOCAL="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '<this-mac-ip>')"
say "GrowPoint Backstage is running and will start automatically at boot"
cat <<MSG

  Admin:      http://${IP}:${PORT}/admin      (or http://${HOSTNAME_LOCAL}:${PORT}/admin)
  Dashboard:  http://${IP}:${PORT}/dashboard/

  Open the Admin link on this Mac first to choose the admin password.

  Logs:       ${APP_DIR}/logs/greenroom.log
  Update:     ./deploy/macos/update.sh
  Remove:     ./deploy/macos/uninstall.sh
  Full guide: docs/DEPLOY-MAC.md
MSG
