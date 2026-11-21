#!/usr/bin/env bash
# Generates the admin page screenshots (every screen, desktop and 375 px phone
# width, light and dark) into docs/images/admin/. It builds the page if needed,
# starts a scratch Stack on a free port with its own temporary data folder
# (never the live Stack), and drives headless Google Chrome. Needs bun and a
# Chrome (set CHROME_BIN for a different path). Nothing is sent anywhere.
#
#   bash scripts/make-admin-screenshots.sh
#   SHOTS_ONLY=overview,health bash scripts/make-admin-screenshots.sh   # some screens only
#   SHOTS_OUT=/tmp/shots bash scripts/make-admin-screenshots.sh         # another folder
set -euo pipefail
cd "$(dirname "$0")/.."
(cd admin-ui && bun run build >/dev/null)
exec bun scripts/admin-screenshots/capture.ts
