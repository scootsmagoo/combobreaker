#!/usr/bin/env bash
# Registers the ComboBreaker yt-dlp native messaging host on macOS / Linux.
#
#   ./install.sh <extension-id> [chrome|chromium|brave|edge|vivaldi ...]
#
# Re-run with another extension id to append it to allowed_origins.

set -euo pipefail

EXT_ID="${1:-}"
shift || true
BROWSERS=("$@")
if [ ${#BROWSERS[@]} -eq 0 ]; then BROWSERS=("chrome"); fi
HOST_NAME="com.combobreaker.ytdlp"

if ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "usage: $0 <32-char extension id> [browser ...]" >&2
  echo "Find the id at chrome://extensions (Developer mode on) or in ComboBreaker's options page." >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_JS="$HERE/host.js"
[ -f "$HOST_JS" ] || { echo "host.js not found at $HOST_JS" >&2; exit 1; }

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found on PATH. Install Node.js first." >&2; exit 1; }

INSTALL_DIR="$HOME/.config/combobreaker/native"
mkdir -p "$INSTALL_DIR"

WRAPPER="$INSTALL_DIR/combobreaker_host.sh"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec "$NODE" "$HOST_JS" "\$@"
EOF
chmod +x "$WRAPPER"

MANIFEST="$INSTALL_DIR/$HOST_NAME.json"
ORIGIN="chrome-extension://$EXT_ID/"
ORIGINS=("$ORIGIN")
if [ -f "$MANIFEST" ]; then
  while IFS= read -r o; do
    [ -n "$o" ] && [ "$o" != "$ORIGIN" ] && ORIGINS+=("$o")
  done < <(grep -o 'chrome-extension://[a-p]\{32\}/' "$MANIFEST" || true)
fi
ORIGINS_JSON="$(printf '"%s",' "${ORIGINS[@]}")"
ORIGINS_JSON="[${ORIGINS_JSON%,}]"
cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "ComboBreaker yt-dlp bridge",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": $ORIGINS_JSON
}
EOF

for b in "${BROWSERS[@]}"; do
  if [ "$(uname)" = "Darwin" ]; then
    case "$b" in
      chrome)   DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
      chromium) DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts" ;;
      brave)    DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" ;;
      edge)     DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" ;;
      vivaldi)  DIR="$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts" ;;
      *) echo "unknown browser $b" >&2; continue ;;
    esac
  else
    case "$b" in
      chrome)   DIR="$HOME/.config/google-chrome/NativeMessagingHosts" ;;
      chromium) DIR="$HOME/.config/chromium/NativeMessagingHosts" ;;
      brave)    DIR="$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" ;;
      edge)     DIR="$HOME/.config/microsoft-edge/NativeMessagingHosts" ;;
      vivaldi)  DIR="$HOME/.config/vivaldi/NativeMessagingHosts" ;;
      *) echo "unknown browser $b" >&2; continue ;;
    esac
  fi
  mkdir -p "$DIR"
  cp "$MANIFEST" "$DIR/$HOST_NAME.json"
  echo "Registered: $DIR/$HOST_NAME.json"
done

echo
command -v yt-dlp >/dev/null 2>&1 && echo "yt-dlp: $(command -v yt-dlp)" || echo "WARNING: yt-dlp not on PATH (brew install yt-dlp / pipx install yt-dlp)"
command -v ffmpeg >/dev/null 2>&1 && echo "ffmpeg: $(command -v ffmpeg)" || echo "WARNING: ffmpeg not on PATH (brew install ffmpeg / apt install ffmpeg)"
echo
echo "Done. Fully quit and relaunch the browser, then open ComboBreaker > Media to confirm."
