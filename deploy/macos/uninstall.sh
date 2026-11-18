#!/bin/bash
# Green Room — stop and remove the background service. Your data folder is kept.
set -euo pipefail
LABEL="church.growpoint.greenroom"
sudo launchctl bootout "system/${LABEL}" 2>/dev/null || true
sudo rm -f "/Library/LaunchDaemons/${LABEL}.plist"
echo "Green Room service removed. Data is still in $(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/data"
