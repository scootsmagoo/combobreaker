# ComboBreaker Helper

The optional native-messaging host that lets the extension run **yt-dlp**
(and **ffmpeg**) on the user's machine, so YouTube, DASH and split-audio HLS
downloads are one click with progress in the badge and the popup.

Nothing here makes network requests of its own. The host only spawns
yt-dlp, which talks to the video site exactly as if you ran it in a terminal.

## What users see

The extension's setup page (`viewer/helper_setup.html`, opened from a YouTube
badge, the popup or options) shows one step for the user's OS:

- **macOS / Linux**: copy one line, paste it into Terminal.
  `curl -fsSL https://raw.githubusercontent.com/scootsmagoo/combobreaker/main/native/install.sh | bash -s -- <extension-id>`
- **Windows**: click *Download the installer*; the extension writes
  `Install ComboBreaker Helper.cmd` (this folder's `install.cmd` with the
  extension id filled in) to Downloads; double-click it.

The page polls the host and turns green when it answers. No browser restart.

## What gets installed

One folder, nothing on PATH, no admin rights:

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/ComboBreaker/helper` |
| Linux | `~/.local/share/combobreaker/helper` (`$XDG_DATA_HOME` honoured) |
| Windows | `%LOCALAPPDATA%\ComboBreaker\helper` |

```
helper/
  host.js                  this host (copied from the repo / raw GitHub)
  run-host.sh|.cmd         wrapper: puts bin/ first on PATH, sets CB_HELPER_DIR, execs node host.js
  com.combobreaker.ytdlp.json   native messaging manifest (allowed_origins = extension ids)
  bin/node(.exe)           Node 22 from nodejs.org (SHA-256 verified)
  python/                  python-build-standalone 3.13 (SHA-256 verified)
  yt-dlp.pyz               yt-dlp's zip build (SHA-256 verified); self-updates with -U
  bin/yt-dlp(.cmd)         convenience wrapper: python yt-dlp.pyz
  bin/ffmpeg(.exe)         static build from eugeneware/ffmpeg-static
  uninstall.sh             (Windows: ..\Uninstall ComboBreaker Helper.cmd)
```

The manifest is copied into every Chromium browser's `NativeMessagingHosts`
directory that exists on the machine (Chrome always; Chromium, Brave, Edge,
Vivaldi, Arc when found). On Windows it is registered under
`HKCU\Software\<browser>\NativeMessagingHosts\com.combobreaker.ytdlp`.

Why the zip build and not the single-file `yt-dlp_macos` binary: on macOS
every launch of the PyInstaller binary re-unpacks and re-validates ~40 MB of
libraries, which costs about 7 seconds before yt-dlp even starts. The zip
build on a persistent Python starts in 0.3 s.

## Files in this folder

| File | What |
|---|---|
| `host.js` | The host. Node.js, no dependencies. Reads framed JSON on stdin, writes framed JSON on stdout. |
| `install.sh` | macOS / Linux installer. Works piped from curl or run from a checkout (then it copies the local `host.js`). Flags: `--browsers chrome,brave`, `--update`, `--source <url>`. |
| `install.cmd` | Windows installer. A `.cmd` that runs its own embedded PowerShell. `__CB_EXT_ID__` / `__CB_SOURCE__` are filled in by the extension; you can also pass an id as the first argument. |

Developers working from a checkout:

```
./native/install.sh <extension-id>            # macOS / Linux
native\install.cmd <extension-id>             # Windows
```

Find the extension id at `chrome://extensions` (Developer mode) or in
ComboBreaker's options › Downloads › Advanced.

## Protocol

Both directions: 4-byte little-endian length + UTF-8 JSON.

| From extension | Host replies |
|---|---|
| `{type:"ping", force?, ytdlpPath?, ffmpegPath?, outputDir?}` | `{type:"pong", version, platform, node, helperDir, ytdlp:{path,args?,version,helper?}\|null, ffmpeg:{…}\|null, outputDir}` |
| `{type:"download", id, url, quality, outputDir?, ytdlpPath?, ffmpegPath?, preferMp4?, extraArgs?, cookiesFromBrowser?, cookies?, referer?}` | `started`, then `progress` events `{id, status, percent, downloaded, total, speed, eta}` (`status:"updating"` while yt-dlp self-updates), then `done {id, filepath}` or `error {id, message, log}` |
| `{type:"cancel", id}` | `{type:"cancelled", id}` |
| `{type:"reveal", path}` | opens the file's folder in Explorer / Finder |
| `{type:"log-tail", id}` | `{type:"log", id, lines}` |
| `{type:"update", id}` | `{type:"updated", id, ok, updated, version, output}` |

`quality` is one of `best`, `1080`, `720`, `480`, `audio`. With `preferMp4`
the host adds `-S res,ext:mp4:m4a --merge-output-format mp4` so YouTube
downloads come out as H.264/AAC `.mp4` instead of VP9/Opus `.webm`.

`cookies` is a Netscape-format cookie file as text; the host writes it to a
mode-600 temp file, passes `--cookies`, and deletes it when the job ends.
The extension only sends it when "Use my browser's cookies" is on.

The host passes `--js-runtimes node:<itself>` so yt-dlp has the JavaScript
runtime YouTube extraction has required since late 2025.

Tool lookup order: explicit path from options → the Helper bundle
(`CB_HELPER_DIR`) → `PATH` → the usual per-platform install locations →
`python -m yt_dlp`.

Output filename template: `%(title).120B [%(id)s].%(ext)s` under
`outputDir` (default `~/Downloads/combobreaker`).

## Troubleshooting

- **"Helper not installed"**: the browser found no manifest. Run the setup
  again; on macOS make sure you pasted the whole line.
- **"installed for a different copy of ComboBreaker"**: `allowed_origins`
  doesn't include this extension's id (unpacked extensions get a new id when
  the folder moves). Run the setup again; ids are appended, not replaced.
- **"Helper quit right after starting"**: the wrapper couldn't start Node.
  Re-run the installer, which re-downloads anything that doesn't run.
- **Downloads fail with "Sign in to confirm you're not a bot"**: YouTube's
  bot check for your network. Options › Downloads › *Use my browser's cookies*.
- **Other yt-dlp errors**: the popup's job row shows the last error line and
  the host has already tried `yt-dlp -U` once if the error looked like site
  breakage. Options › *Update yt-dlp* runs it by hand.
