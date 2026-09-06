#!/usr/bin/env bash
# Fetch a current yt-dlp beside this script.
#
# Not bundled with the analyzer deliberately: yt-dlp exists to keep up with
# YouTube's changes and is updated constantly, so a copy frozen at release time
# eventually stops working. Re-run this whenever downloads start failing.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HERE/yt-dlp"

case "$(uname -s)" in
  Darwin) ASSET=yt-dlp_macos ;;
  Linux)  ASSET=yt-dlp ;;
  *)      ASSET=yt-dlp ;;
esac

echo "fetching $ASSET"
curl -fL --progress-bar -o "$DEST" \
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$ASSET"
chmod +x "$DEST"
"$DEST" --version >/dev/null && echo "yt-dlp $("$DEST" --version) ready at $DEST"
