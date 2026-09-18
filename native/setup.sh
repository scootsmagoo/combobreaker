#!/usr/bin/env bash
# One-shot installer for the ComboBreaker video download helper (macOS / Linux).
#
# Meant to be run straight from the command ComboBreaker's Setup page shows:
#
#   curl -fsSL <raw url>/native/setup.sh | bash -s -- <extension-id>
#
# It does everything, and is safe to re-run:
#   1. installs yt-dlp, ffmpeg and Node.js if missing (Homebrew, or apt/dnf/pacman)
#   2. puts the helper (host.js) in ~/.config/combobreaker/native
#   3. registers it with Chrome, Chromium, Brave, Edge and Vivaldi

set -euo pipefail

EXT_ID="${1:-}"
SOURCE="${COMBOBREAKER_SOURCE:-https://raw.githubusercontent.com/scootsmagoo/combobreaker/main/native}"
HOST_NAME="com.combobreaker.ytdlp"

if ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "usage: setup.sh <32-char extension id>   (copy the full command from ComboBreaker's Setup page)" >&2
  exit 1
fi

step() { printf '\n== %s\n' "$1"; }

install_pkg() { # install_pkg <command> <package>
  if command -v "$1" >/dev/null 2>&1; then echo "$1 already installed: $(command -v "$1")"; return; fi
  echo "Installing $2..."
  if command -v brew >/dev/null 2>&1; then brew install "$2"
  elif command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y "$2"
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y "$2"
  elif command -v pacman >/dev/null 2>&1; then sudo pacman -S --noconfirm "$2"
  else echo "WARNING: no supported package manager found. Install $2 yourself, then re-run." >&2
  fi
}

step "1/3  Tools (yt-dlp, ffmpeg, Node.js)"
if [ "$(uname)" = "Darwin" ] && ! command -v brew >/dev/null 2>&1; then
  # Apple Silicon installs brew outside the default PATH of a fresh shell.
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$b" ] && eval "$("$b" shellenv)" && break
  done
fi
if [ "$(uname)" = "Darwin" ] && ! command -v brew >/dev/null 2>&1; then
  cat >&2 <<'MSG'
Homebrew is needed to install the tools on macOS. Install it with:

  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

then run the ComboBreaker command again.
MSG
  exit 1
fi
install_pkg yt-dlp yt-dlp
install_pkg ffmpeg ffmpeg
if command -v brew >/dev/null 2>&1; then install_pkg node node; else install_pkg node nodejs; fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js is required for the helper. Install it, then re-run this command." >&2; exit 1; }

step "2/3  Helper"
INSTALL_DIR="$HOME/.config/combobreaker/native"
mkdir -p "$INSTALL_DIR"
HOST_JS="$INSTALL_DIR/host.js"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-/dev/null}")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/host.js" ]; then
  cp "$HERE/host.js" "$HOST_JS"; echo "Copied host.js from $HERE"
else
  curl -fsSL "$SOURCE/host.js" -o "$HOST_JS"; echo "Downloaded host.js from $SOURCE"
fi

WRAPPER="$INSTALL_DIR/combobreaker_host.sh"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec "$NODE" "$HOST_JS" "\$@"
EOF
chmod +x "$WRAPPER"

step "3/3  Browser registration"
MANIFEST="$INSTALL_DIR/$HOST_NAME.json"
ORIGIN="chrome-extension://$EXT_ID/"
ORIGINS=("$ORIGIN")
if [ -f "$MANIFEST" ]; then
  while IFS= read -r o; do
    [ -n "$o" ] && [ "$o" != "$ORIGIN" ] && ORIGINS+=("$o")
  done < <(grep -o 'chrome-extension://[a-p]\{32\}/' "$MANIFEST" || true)
fi
ORIGINS_JSON="$(printf '"%s",' "${ORIGINS[@]}")"
cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "ComboBreaker yt-dlp bridge",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": [${ORIGINS_JSON%,}]
}
EOF

if [ "$(uname)" = "Darwin" ]; then
  BASE="$HOME/Library/Application Support"
  DIRS=("$BASE/Google/Chrome" "$BASE/Chromium" "$BASE/BraveSoftware/Brave-Browser" "$BASE/Microsoft Edge" "$BASE/Vivaldi")
else
  BASE="$HOME/.config"
  DIRS=("$BASE/google-chrome" "$BASE/chromium" "$BASE/BraveSoftware/Brave-Browser" "$BASE/microsoft-edge" "$BASE/vivaldi")
fi
for d in "${DIRS[@]}"; do
  # Only browsers that exist; don't litter config dirs for ones that don't.
  [ -d "$d" ] || continue
  mkdir -p "$d/NativeMessagingHosts"
  cp "$MANIFEST" "$d/NativeMessagingHosts/$HOST_NAME.json"
  echo "Registered: $d"
done

printf '\nAll set. Go back to the ComboBreaker Setup page and click "Check again".\n'
