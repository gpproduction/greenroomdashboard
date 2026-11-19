#!/bin/bash
# GrowPoint Backstage — pull the latest version and restart the service.
set -euo pipefail
LABEL="church.growpoint.greenroom"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_DIR"

echo "==> Backing up data"
mkdir -p data/backups
[[ -f data/db.json ]] && cp data/db.json "data/backups/db-$(date +%Y%m%d-%H%M%S).json"
ls -1t data/backups/db-*.json 2>/dev/null | tail -n +21 | xargs -r rm -f   # keep the last 20

echo "==> Downloading the latest version"
git pull --ff-only

echo "==> Installing dependencies"
NODE_BIN="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "/Library/LaunchDaemons/${LABEL}.plist")"
"$(dirname "$NODE_BIN")/npm" ci --omit=dev --no-audit --no-fund

echo "==> Restarting (you may be asked for your Mac password)"
sudo launchctl kickstart -k "system/${LABEL}"
echo "Done. Open dashboards will reload themselves within a few seconds."
