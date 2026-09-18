#!/usr/bin/env bash
# ComboBreaker Helper installer — macOS / Linux.
#
# The extension's setup page gives users one line to paste into Terminal:
#   curl -fsSL https://raw.githubusercontent.com/scootsmagoo/combobreaker/main/native/install.sh | bash -s -- <extension-id>
# From a checkout (uses the host.js next to this file):
#   ./native/install.sh <extension-id> [<extension-id> ...] [--browsers chrome,brave] [--update]
#
# What it does (nothing touches PATH, /usr/local, or Homebrew):
#   1. Downloads private copies of Node (runs host.js), a standalone Python with
#      yt-dlp's zip build (the single-file yt-dlp binary takes ~7 s to start on
#      macOS because every launch re-unpacks and re-validates it), and ffmpeg, into
#        macOS: ~/Library/Application Support/ComboBreaker/helper
#        Linux: ~/.local/share/combobreaker/helper
#      Node, Python and yt-dlp are checksum-verified against their published SHA-256 lists.
#   2. Writes the native-messaging manifest for every Chromium browser it finds.
#   3. Starts the host once and checks it answers a ping.
# Re-run any time to repair or update. Remove with <helper dir>/uninstall.sh.
set -euo pipefail

HOST_NAME="com.combobreaker.ytdlp"
SOURCE_DEFAULT="https://raw.githubusercontent.com/scootsmagoo/combobreaker/main/native"
NODE_LINE="v22.x"
FFMPEG_TAG="b6.0"
PBS_PY_LINE="3.13"          # python-build-standalone CPython line
PBS_PIN_TAG="20260901"      # fallback when the GitHub API is rate-limited
PBS_PIN_VER="3.13.15"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | sed 's/^# \{0,1\}//'
}

EXT_IDS=()
SOURCE="${CB_SOURCE:-$SOURCE_DEFAULT}"
BROWSERS=""
UPDATE_TOOLS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --source)   SOURCE="$2"; shift 2 ;;
    --browsers) BROWSERS="$2"; shift 2 ;;
    --update)   UPDATE_TOOLS=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    -*)         die "unknown option $1" ;;
    *)          EXT_IDS+=("$1"); shift ;;
  esac
done

[ ${#EXT_IDS[@]} -gt 0 ] || die "extension id required. Open ComboBreaker's setup page (Media tab → Set up) and copy the command shown there."
for id in "${EXT_IDS[@]}"; do
  [[ "$id" =~ ^[a-p]{32}$ ]] || die "'$id' is not a Chrome extension id (32 letters a–p). Copy the command from ComboBreaker's setup page."
done

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) HELPER="$HOME/Library/Application Support/ComboBreaker/helper" ;;
  Linux)  HELPER="${XDG_DATA_HOME:-$HOME/.local/share}/combobreaker/helper" ;;
  *)      die "unsupported OS '$OS' (on Windows use install.cmd)" ;;
esac
case "$OS/$ARCH" in
  Darwin/arm64)          NODE_PLAT="darwin-arm64"; FF_ASSET="ffmpeg-darwin-arm64"; PBS_TRIPLE="aarch64-apple-darwin" ;;
  Darwin/x86_64)         NODE_PLAT="darwin-x64";   FF_ASSET="ffmpeg-darwin-x64";   PBS_TRIPLE="x86_64-apple-darwin" ;;
  Linux/x86_64)          NODE_PLAT="linux-x64";    FF_ASSET="ffmpeg-linux-x64";    PBS_TRIPLE="x86_64-unknown-linux-gnu" ;;
  Linux/aarch64|Linux/arm64) NODE_PLAT="linux-arm64"; FF_ASSET="ffmpeg-linux-arm64"; PBS_TRIPLE="aarch64-unknown-linux-gnu" ;;
  *)                     die "unsupported platform $OS/$ARCH" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar  >/dev/null 2>&1 || die "tar is required"

BIN="$HELPER/bin"
NODE="$BIN/node"
PY_DIR="$HELPER/python"
PY="$PY_DIR/bin/python3"
PYZ="$HELPER/yt-dlp.pyz"
YTDLP="$BIN/yt-dlp"
FFMPEG="$BIN/ffmpeg"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/combobreaker-helper.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fetch() { # url dest
  curl -fL --retry 3 --retry-delay 2 --progress-bar -o "$2" "$1" || die "download failed: $1"
}
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}
make_runnable() { # path
  chmod +x "$1"
  if [ "$OS" = "Darwin" ]; then
    xattr -d com.apple.quarantine "$1" 2>/dev/null || true
    # Apple Silicon refuses unsigned binaries outright; an ad-hoc signature is enough.
    if command -v codesign >/dev/null 2>&1 && ! codesign --verify "$1" >/dev/null 2>&1; then
      codesign --force --sign - "$1" >/dev/null 2>&1 || true
    fi
  fi
}

bold "ComboBreaker Helper installer"
echo "    Folder: $HELPER"
mkdir -p "$BIN"

# ---------- 1. host.js ----------
step "Host script"
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/host.js" ]; then
  cp "$SCRIPT_DIR/host.js" "$HELPER/host.js"
  ok "copied host.js from $SCRIPT_DIR"
else
  fetch "$SOURCE/host.js" "$HELPER/host.js"
  ok "downloaded host.js"
fi

# ---------- 2. Node ----------
step "Node runtime"
if [ "$UPDATE_TOOLS" = 0 ] && "$NODE" --version >/dev/null 2>&1; then
  ok "already installed ($("$NODE" --version))"
else
  fetch "https://nodejs.org/dist/latest-$NODE_LINE/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
  line="$(grep -E "node-v[0-9.]+-$NODE_PLAT\.tar\.gz\$" "$TMP/SHASUMS256.txt" | head -1 || true)"
  [ -n "$line" ] || die "no Node $NODE_LINE build for $NODE_PLAT"
  fname="${line##* }"
  want="${line%% *}"
  fetch "https://nodejs.org/dist/latest-$NODE_LINE/$fname" "$TMP/$fname"
  [ "$(sha256_of "$TMP/$fname")" = "$want" ] || die "Node download failed its checksum; try again"
  tar -xzf "$TMP/$fname" -C "$TMP" "${fname%.tar.gz}/bin/node"
  mv -f "$TMP/${fname%.tar.gz}/bin/node" "$NODE"
  make_runnable "$NODE"
  ok "installed $("$NODE" --version)"
fi

# ---------- 3. Python + yt-dlp ----------
step "Python runtime (for yt-dlp)"
if [ "$UPDATE_TOOLS" = 0 ] && "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
  ok "already installed ($("$PY" --version 2>&1))"
else
  asset=""
  # Newest build via the GitHub API; pinned build if the API is rate-limited.
  api="$(curl -fsSL --max-time 20 https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest 2>/dev/null || true)"
  if [ -n "$api" ]; then
    asset="$(printf '%s' "$api" \
      | grep -o "\"browser_download_url\": *\"[^\"]*cpython-$PBS_PY_LINE\.[0-9]*%2B[0-9]*-$PBS_TRIPLE-install_only\.tar\.gz\"" \
      | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
  fi
  [ -n "$asset" ] || asset="https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_PIN_TAG/cpython-$PBS_PIN_VER%2B$PBS_PIN_TAG-$PBS_TRIPLE-install_only.tar.gz"
  fetch "$asset" "$TMP/python.tar.gz"
  want=""
  if curl -fsSL --max-time 30 -o "$TMP/python.sha256" "$asset.sha256" 2>/dev/null; then
    want="$(awk '{print $1}' "$TMP/python.sha256" | head -1)"
  else
    sums="${asset%/*}/SHA256SUMS"
    aname="${asset##*/}"; aname="${aname//%2B/+}"
    curl -fsSL --max-time 30 -o "$TMP/SHA256SUMS" "$sums" 2>/dev/null || true
    [ -f "$TMP/SHA256SUMS" ] && want="$(awk -v n="$aname" '$2 == n { print $1 }' "$TMP/SHA256SUMS" | head -1)"
  fi
  [ -n "$want" ] || die "could not fetch the Python checksum; try again"
  [ "$(sha256_of "$TMP/python.tar.gz")" = "$want" ] || die "Python download failed its checksum; try again"
  rm -rf "$PY_DIR" "$TMP/py"
  mkdir -p "$TMP/py"
  tar -xzf "$TMP/python.tar.gz" -C "$TMP/py"
  mv "$TMP/py/python" "$PY_DIR"
  for f in "$PY_DIR"/bin/python3.*; do
    [ -f "$f" ] && [ ! -L "$f" ] && make_runnable "$f"
  done
  "$PY" --version >/dev/null 2>&1 || die "downloaded Python does not run on this machine"
  ok "installed $("$PY" --version 2>&1)"
fi

step "yt-dlp"
if [ -f "$PYZ" ] && "$PY" "$PYZ" --version >/dev/null 2>&1; then
  if "$PY" "$PYZ" -U >/dev/null 2>&1; then ok "up to date ($("$PY" "$PYZ" --version))"
  else warn "self-update failed; keeping $("$PY" "$PYZ" --version)"; fi
else
  fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" "$TMP/yt-dlp.pyz"
  fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS" "$TMP/SHA2-256SUMS"
  want="$(awk '$2 == "yt-dlp" { print $1 }' "$TMP/SHA2-256SUMS" | head -1)"
  [ -n "$want" ] || die "yt-dlp checksum list has no entry for the zip build"
  [ "$(sha256_of "$TMP/yt-dlp.pyz")" = "$want" ] || die "yt-dlp download failed its checksum; try again"
  mv -f "$TMP/yt-dlp.pyz" "$PYZ"
  ok "installed $("$PY" "$PYZ" --version)"
fi
# Plain `yt-dlp` command for anyone poking around the folder.
cat > "$YTDLP" <<WRAP
#!/usr/bin/env bash
HERE="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
exec "\$HERE/python/bin/python3" "\$HERE/yt-dlp.pyz" "\$@"
WRAP
chmod +x "$YTDLP"

# ---------- 4. ffmpeg ----------
step "ffmpeg"
if [ "$UPDATE_TOOLS" = 0 ] && "$FFMPEG" -version >/dev/null 2>&1; then
  ok "already installed"
else
  fetch "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_TAG/$FF_ASSET" "$TMP/$FF_ASSET"
  mv -f "$TMP/$FF_ASSET" "$FFMPEG"
  make_runnable "$FFMPEG"
  "$FFMPEG" -version >/dev/null 2>&1 || die "downloaded ffmpeg does not run on this machine"
  ok "installed $("$FFMPEG" -version | head -1 | awk '{print $3}')"
fi

# ---------- 5. wrapper + manifest ----------
step "Registering with the browser"
cat > "$HELPER/run-host.sh" <<WRAP
#!/usr/bin/env bash
# Launched by the browser through native messaging. Keeps the helper's private
# tools first on PATH so host.js finds this yt-dlp/ffmpeg before any other copy.
HERE="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export PATH="\$HERE/bin:\$PATH"
export CB_HELPER_DIR="\$HERE"
exec "\$HERE/bin/node" "\$HERE/host.js" "\$@"
WRAP
chmod +x "$HELPER/run-host.sh"

MANIFEST="$HELPER/$HOST_NAME.json"
ORIGINS=()
for id in "${EXT_IDS[@]}"; do ORIGINS+=("chrome-extension://$id/"); done
if [ -f "$MANIFEST" ]; then
  while IFS= read -r o; do
    keep=1
    for have in "${ORIGINS[@]}"; do [ "$have" = "$o" ] && keep=0; done
    [ "$keep" = 1 ] && [ -n "$o" ] && ORIGINS+=("$o")
  done < <(grep -o 'chrome-extension://[a-p]\{32\}/' "$MANIFEST" || true)
fi
ORIGINS_JSON="$(printf '"%s",' "${ORIGINS[@]}")"
ORIGINS_JSON="[${ORIGINS_JSON%,}]"
cat > "$MANIFEST" <<JSON
{
  "name": "$HOST_NAME",
  "description": "ComboBreaker Helper (runs yt-dlp locally)",
  "path": "$HELPER/run-host.sh",
  "type": "stdio",
  "allowed_origins": $ORIGINS_JSON
}
JSON

browser_dir() { # name -> NativeMessagingHosts dir (empty if unknown)
  if [ "$OS" = "Darwin" ]; then
    local base="$HOME/Library/Application Support"
    case "$1" in
      chrome)   echo "$base/Google/Chrome/NativeMessagingHosts" ;;
      chromium) echo "$base/Chromium/NativeMessagingHosts" ;;
      brave)    echo "$base/BraveSoftware/Brave-Browser/NativeMessagingHosts" ;;
      edge)     echo "$base/Microsoft Edge/NativeMessagingHosts" ;;
      vivaldi)  echo "$base/Vivaldi/NativeMessagingHosts" ;;
      arc)      echo "$base/Arc/User Data/NativeMessagingHosts" ;;
    esac
  else
    local base="${XDG_CONFIG_HOME:-$HOME/.config}"
    case "$1" in
      chrome)   echo "$base/google-chrome/NativeMessagingHosts" ;;
      chromium) echo "$base/chromium/NativeMessagingHosts" ;;
      brave)    echo "$base/BraveSoftware/Brave-Browser/NativeMessagingHosts" ;;
      edge)     echo "$base/microsoft-edge/NativeMessagingHosts" ;;
      vivaldi)  echo "$base/vivaldi/NativeMessagingHosts" ;;
    esac
  fi
}
ALL_BROWSERS="chrome chromium brave edge vivaldi arc"
if [ -n "$BROWSERS" ]; then
  TARGETS="${BROWSERS//,/ }"
else
  # Every browser whose profile folder exists, and Chrome regardless.
  TARGETS="chrome"
  for b in $ALL_BROWSERS; do
    d="$(browser_dir "$b")"
    [ -n "$d" ] && [ -d "$(dirname "$d")" ] && [ "$b" != chrome ] && TARGETS="$TARGETS $b"
  done
fi
REGISTERED=()
for b in $TARGETS; do
  d="$(browser_dir "$b")"
  [ -n "$d" ] || { warn "unknown browser '$b'"; continue; }
  mkdir -p "$d"
  cp "$MANIFEST" "$d/$HOST_NAME.json"
  REGISTERED+=("$d/$HOST_NAME.json")
  ok "$b"
done

# ---------- 6. uninstaller ----------
{
  echo '#!/usr/bin/env bash'
  echo '# Removes the ComboBreaker Helper and its browser registrations.'
  for f in "${REGISTERED[@]}"; do printf 'rm -f "%s"\n' "$f"; done
  for b in $ALL_BROWSERS; do d="$(browser_dir "$b")"; [ -n "$d" ] && printf 'rm -f "%s/%s.json"\n' "$d" "$HOST_NAME"; done
  printf 'rm -rf "%s"\n' "$HELPER"
  echo 'echo "ComboBreaker Helper removed."'
} > "$HELPER/uninstall.sh"
chmod +x "$HELPER/uninstall.sh"

# ---------- 7. self-test ----------
step "Checking the helper answers"
if "$NODE" -e '
  const { spawn } = require("child_process");
  const p = spawn(process.argv[1], [], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = Buffer.alloc(0);
  p.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length < 4) return;
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) return;
    const m = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
    p.kill();
    if (m.type === "pong" && m.ytdlp && m.ytdlp.path) {
      console.log("    yt-dlp " + m.ytdlp.version + (m.ytdlp.helper ? " (bundled)" : " (" + m.ytdlp.path + ")") + (m.ffmpeg ? " · ffmpeg " + m.ffmpeg.version : " · ffmpeg missing"));
      process.exit(0);
    }
    console.error("    unexpected reply: " + JSON.stringify(m));
    process.exit(1);
  });
  const j = Buffer.from(JSON.stringify({ type: "ping", force: true }));
  const h = Buffer.alloc(4); h.writeUInt32LE(j.length, 0);
  p.stdin.write(Buffer.concat([h, j]));
  setTimeout(() => { console.error("    timeout"); process.exit(1); }, 60000);
' "$HELPER/run-host.sh"; then
  ok "helper responds"
else
  die "the helper did not answer a ping. Re-run this installer; if it keeps failing, open an issue with the output above."
fi

echo
bold "Done. Go back to your browser — ComboBreaker will show the helper as Connected."
echo "    (If it still says not connected after a few seconds, fully quit and reopen the browser.)"
echo "    Remove later with: \"$HELPER/uninstall.sh\""
