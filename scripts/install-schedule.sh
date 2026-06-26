#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
: "${SYNC_SHEET_ID:?set SYNC_SHEET_ID to the target spreadsheet id}"
: "${GOOGLE_SHEETS_CREDENTIALS:?set GOOGLE_SHEETS_CREDENTIALS to the service-account JSON path}"

DEST="$HOME/Library/LaunchAgents/com.tradingview-mcp.sync.plist"
mkdir -p "$REPO/.cache" "$HOME/Library/LaunchAgents"

sed -e "s#__REPO__#$REPO#g" \
    -e "s#__SHEET_ID__#$SYNC_SHEET_ID#g" \
    -e "s#__CREDS__#$GOOGLE_SHEETS_CREDENTIALS#g" \
    "$REPO/scripts/com.tradingview-mcp.sync.plist" > "$DEST"

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"
echo "Loaded $DEST — runs daily at 15:30. Edit StartCalendarInterval in the plist to change the time."
echo "Run now to test: launchctl start com.tradingview-mcp.sync ; tail -f $REPO/.cache/sync.log"
