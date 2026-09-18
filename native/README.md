# ComboBreaker yt-dlp bridge

> **Quick install:** open ComboBreaker → Media tab → **Set up** (or Options → **Set up video downloads…**).
> The page shows one command to paste into a terminal; it runs `setup.ps1` (Windows) or `setup.sh`
> (macOS / Linux) from this folder, which installs yt-dlp, ffmpeg and Node.js if missing, copies
> `host.js` into your user profile and registers it with your browsers. The manual steps below are
> only needed if you want to run the host from a source checkout (`install.ps1` / `install.sh`).

A tiny [native messaging host](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
that lets the extension run a **locally installed** `yt-dlp` (and `ffmpeg`).
With it, the on-page download badge and the Media tab can download YouTube,
DASH streams, and HLS with separate audio tracks in one click, with progress
shown in the badge and the popup.

Nothing here makes network requests of its own. The host only spawns
`yt-dlp`, which talks to the video site exactly as if you ran it in a terminal.

## Files

| File | What |
|---|---|
| `host.js` | The host. Node.js, no dependencies. Reads framed JSON on stdin, writes framed JSON on stdout. |
| `install.ps1` | Windows installer. Writes a wrapper `.bat` + host manifest under `%LOCALAPPDATA%\ComboBreaker\native` and registers it in `HKCU`. |
| `uninstall.ps1` | Removes the registry keys and the folder above. |
| `install.sh` | macOS / Linux installer (writes to the browser's `NativeMessagingHosts` dir). |

## Install (Windows)

1. Tools:
   ```
   winget install yt-dlp.yt-dlp Gyan.FFmpeg OpenJS.NodeJS.LTS
   ```
   (`ffmpeg` is optional but without it YouTube is limited to single-file
   formats, usually 720p, and audio-only MP3 isn't available.)
2. Find the extension ID: ComboBreaker → Options → **Downloads** shows it, or
   `chrome://extensions` with Developer mode on.
3. From the repo folder:
   ```
   powershell -ExecutionPolicy Bypass -File .\native\install.ps1 -ExtensionId <id>
   ```
   Add `-Browser chrome,edge,brave` to register for several browsers.
4. Fully quit and relaunch the browser. Options → Downloads should show
   **Connected**.

The wrapper points at `host.js` *inside the repo*, so `git pull` updates the
host too. If you move the repo, re-run the installer.

## Install (macOS / Linux)

```
brew install yt-dlp ffmpeg node        # or your distro's packages
./native/install.sh <extension-id> [chrome|chromium|brave|edge|vivaldi ...]
```

## Protocol

Both directions: 4-byte little-endian length + UTF-8 JSON.

| From extension | Host replies |
|---|---|
| `{type:"ping", ytdlpPath?, ffmpegPath?, outputDir?}` | `{type:"pong", version, ytdlp:{path,version}\|null, ffmpeg:{…}\|null, outputDir}` |
| `{type:"download", id, url, quality, outputDir?, ytdlpPath?, ffmpegPath?, preferMp4?, extraArgs?, cookiesFromBrowser?, referer?}` | `started`, then `progress` events `{id, status, percent, downloaded, total, speed, eta}`, then `done {id, filepath}` or `error {id, message, log}` |
| `{type:"cancel", id}` | `{type:"cancelled", id}` |
| `{type:"reveal", path}` | opens the file's folder in Explorer / Finder |
| `{type:"log-tail", id}` | `{type:"log", id, lines}` |

`quality` is one of `best`, `1080`, `720`, `480`, `audio`. With `preferMp4`
the host adds `-S res,ext:mp4:m4a --merge-output-format mp4` so YouTube
downloads come out as H.264/AAC `.mp4` instead of VP9/Opus `.webm`.

Output filename template: `%(title).120B [%(id)s].%(ext)s` under
`outputDir` (default `~/Downloads/combobreaker`).

## Troubleshooting

- **"Specified native messaging host not found"**: the registry key is
  missing for this browser. Re-run `install.ps1` (with `-Browser edge` etc.).
- **"Access to the specified native messaging host is forbidden"**: the
  manifest's `allowed_origins` doesn't include this extension's ID. Re-run the
  installer with the ID shown in Options → Downloads (unpacked extensions get
  a new ID if the folder moves).
- **"Native host has exited"**: the wrapper couldn't start Node. Open
  `%LOCALAPPDATA%\ComboBreaker\native\combobreaker_host.bat` and check the
  Node path is right.
- **yt-dlp found but downloads fail**: run the same URL with `yt-dlp` in a
  terminal; the popup's job row shows yt-dlp's last error line. Updating
  yt-dlp (`yt-dlp -U` or `winget upgrade yt-dlp.yt-dlp`) fixes most YouTube
  breakage.
- **Age-gated / members-only**: set *Cookies from browser* in Options. On
  Windows, Chrome must be fully closed for yt-dlp to read its cookie database,
  so a second browser (Firefox) is the practical choice.
