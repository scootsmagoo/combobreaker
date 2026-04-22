# ComboBreaker

> One Chrome extension to replace a dozen sketchy ones.

ComboBreaker is a privacy-respecting consolidation of the small browser tools most of us actually use day-to-day. No telemetry. No analytics. No remote-code loading. No "we got acquired and now we sell your browsing history" surprise updates. Pinned, auditable, MIT-licensed.

It is intentionally **not** a one-for-one replacement for heavyweights like uBlock Origin, Dark Reader, or Vimium — those are huge, ongoing projects. ComboBreaker covers the simpler 80% of what most of those extensions do, in a single auditable codebase.

Inspired by the spirit of [@levelsio's combo-extension thread](https://x.com/levelsio/status/2046271694042505451).

## Features

| Feature | What it does |
|---|---|
| **Per-site JS toggle** | Disable JavaScript on a domain via `chrome.contentSettings`. Survives reloads. |
| **Per-site custom CSS** | A small Stylus-style editor; CSS is injected at `document_start` only on the matching site. |
| **Per-site custom JS** | Inject your own scripts on a domain (no `GM_*` API; just raw script in MAIN world). |
| **Dark mode** | Powered by [Dark Reader](https://darkreader.org/) (vendored, MIT). Global on/off plus per-site overrides (auto / always-on / always-off). Brightness / contrast / sepia / grayscale / mode sliders in the popup and options. |
| **Color picker** | Native `EyeDropper` API — one click, hex copied to clipboard. |
| **Pixel ruler** | On-page draggable ruler overlay. |
| **Font inspector** | Hover any element to see its font stack, size, weight, line-height, color. |
| **JSON formatter** | Auto-pretty-prints `application/json` responses. Tree / Formatted / Raw view modes, depth-level expand buttons (1–5, All), hover for JSON path + click to pin & copy, per-node "expand all descendants", auto/dark/light theme, and `window.data` exposed in the page console. |
| **Full-page screenshot** | Scroll-and-stitch the entire page to a PNG download. |
| **Video downloader** | A "Media" tab in the popup lists every `<video>`/`<audio>` element and every media response the page fetches (mp4, webm, mov, mp3, m4a, HLS `.m3u8`). One click downloads direct files via `chrome.downloads`. HLS streams open a dedicated downloader page that pulls every segment and saves a `.ts` file (run `ffmpeg -i input.ts -c copy output.mp4` if you want MP4). YouTube and other DRM/signed-stream sites get a "Copy yt-dlp command" button instead — see caveats below. |
| **Encoding override** | Manually set character encoding for legacy/garbled pages. |
| **Kagi search** | Sets Kagi as your default search provider on install. |
| **Basic adblock** | Static `declarativeNetRequest` ruleset blocking common ad/tracker domains. |

## Install (developer mode)

Until ComboBreaker is published to the Chrome Web Store, side-load it as an unpacked extension:

1. Clone this repo to a stable location (Chrome reloads the extension from the same folder path on every restart, so don't put it somewhere you'll later move or delete).
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** (top left) and select the repo folder — the one containing `manifest.json`, not a parent or subfolder.
5. The extension appears in your list as "ComboBreaker." If the manifest has an error, Chrome shows it in red — click **Errors** for details.
6. Pin it: click the puzzle-piece icon in the Chrome toolbar, find ComboBreaker, click the pin icon next to it.

On first install Chrome will prompt to confirm the search-provider override (Kagi). Decline if you don't want that.

### Dev loop

- **Edit files** in this repo.
- **Reload the extension** at `chrome://extensions` → click the circular reload arrow on the ComboBreaker card. (Or click **Update** at the top of the page to reload all unpacked extensions at once.)
- **Reload affected tabs** — content scripts only inject on page load, so existing tabs keep running the old code until refreshed.

Rule of thumb for what needs reloading:

| You changed... | Reload extension? | Reload tab? |
|---|---|---|
| `manifest.json`, `background/`, `rules/` | yes | yes |
| `content/`, `tools/`, `viewer/` | usually no | yes |
| `popup/`, `options/` | no | n/a (re-open popup/options page) |

### Debugging

- **Popup**: right-click the toolbar icon → **Inspect popup**. Opens DevTools scoped to the popup.
- **Service worker** (`background/`): on the `chrome://extensions` card, click the **service worker** link to open DevTools for it. MV3 service workers go idle after ~30s — interact with the extension to wake it back up.
- **Content scripts** (`content/site_injector.js`, anything in `tools/`): open DevTools on the target page (`Cmd+Opt+I` on macOS), then in the Console's top-left context dropdown, switch from "top" to the ComboBreaker content-script context to see its logs and inspect its scope.
- **Options page**: right-click the extension icon → **Options**, then DevTools as normal.
- **Errors**: the extension card on `chrome://extensions` shows an **Errors** button in red if anything throws. Click it for stack traces.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+C` | Open popup |
| `Alt+Shift+D` | Toggle dark mode for current site |
| `Alt+Shift+C` | Pick a color from the page |

You can rebind these in `chrome://extensions/shortcuts`.

## Architecture

```
manifest.json              MV3 manifest, permissions, DNR, settings overrides
background/                Service worker (commands, screenshot, content settings,
                           Dark Reader injection)
popup/                     Toolbar popup (per-site toggles, tool launchers)
options/                   Full-page options (CSS/JS editors, global prefs,
                           dark-mode tuning)
content/site_injector.js   Runs at document_start on every page; loads per-site CSS/JS
                           and the dark-mode anti-flash preamble
content/json_formatter.js  Pretty-printer + tree viewer for JSON responses
content/media_finder.js    DOM scanner for the video downloader
tools/                     On-demand tools (color picker, ruler, whatfont)
viewer/                    Extension pages (HLS downloader)
vendor/                    Vendored third-party code (Dark Reader UMD bundle)
rules/                     declarativeNetRequest rulesets
lib/                       Shared storage + URL helpers
icons/                     PNG icons
```

All settings live in `chrome.storage.sync` so they follow your Chrome profile.

### Video downloader

The Media tab in the popup shows everything ComboBreaker has noticed on the current tab — the popup combines two sources, deduped by URL:

- **DOM scan** (`content/media_finder.js`): walks `<video>`, `<audio>`, and `<source>` elements and watches for new ones via a `MutationObserver`.
- **Network sniff** (service worker): `chrome.webRequest.onResponseStarted` flags any response whose `Content-Type` is `video/*`, `audio/*`, `application/vnd.apple.mpegurl` (HLS), or `application/dash+xml` (DASH), or whose URL ends in a known media extension. Per-tab list lives in `chrome.storage.session` and is reset on top-level navigation.

What the buttons do:

- **Direct files** (`mp4`, `webm`, `mov`, `mkv`, `mp3`, `m4a`, etc.) — one click downloads via `chrome.downloads.download` into a `combobreaker/` subfolder.
- **HLS** (`.m3u8`) — opens `viewer/hls_downloader.html` in a new tab. That page parses the manifest, lets you pick a variant if it's a master playlist, then fetches every segment and writes the concatenated MPEG-TS bytes to disk as a single `.ts` file. Works in VLC/mpv as-is. To convert to MP4 without re-encoding: `ffmpeg -i input.ts -c copy output.mp4`.
- **DASH** (`.mpd`) — detection only; no built-in downloader (use yt-dlp).
- **Copy yt-dlp** — copies `yt-dlp "<current tab URL>"` to your clipboard. Use this for YouTube, Vimeo, and anything else that ships signed/DRM streams.

#### Caveats

- **No DRM.** Encrypted HLS (`#EXT-X-KEY` with anything other than `METHOD=NONE`) is detected and refused. Widevine / FairPlay / EME streams are out of scope.
- **No fragmented-MP4 muxing.** HLS streams whose segments are `.m4s` (with an init segment via `#EXT-X-MAP`) are detected and refused — concatenation alone doesn't produce a valid file. A real muxer (ffmpeg.wasm) would be needed; not currently vendored.
- **Live streams** capture only the current sliding window of segments visible in the playlist at fetch time.
- **YouTube** specifically does not work via the direct-download path. YouTube serves signed adaptive DASH segments that change cipher routinely; that's a yt-dlp problem, not a browser-extension problem. The popup detects YouTube hosts and shows a banner pointing at the **Copy yt-dlp** button.

### Dark-mode model

Dark mode is global-by-default, with per-site overrides — same model as Dark Reader itself.

- **Global toggle** (popup → "Dark mode (all sites)") flips dark mode on/off for every page that doesn't have an explicit override.
- **Per-site override** (popup → "This site: Auto / On / Off") opts the current site in or out, regardless of the global toggle. "Auto" means "follow global."
- **Tuning** (popup → "Tune brightness / contrast →" or options page → "Dark mode" section) exposes Dark Reader's sliders: mode (dark/light), brightness, contrast, sepia, grayscale. Changes apply live to every open dark-mode page.
- **Keyboard shortcut** (`Alt+Shift+D`) toggles the per-site override for the current site, matching Dark Reader's behavior — if dark is currently visible, it sets the site to "off"; if not, "on".

## Privacy

ComboBreaker:

- Makes **zero network requests** of its own.
- Has **no analytics, no error reporting, no "anonymous usage" pings**.
- Stores per-site settings in `chrome.storage.sync` (your encrypted Google profile, not our server — we don't have one).
- Asks for `<all_urls>` only because per-site CSS/JS injection cannot work otherwise. You can audit every line of every script that runs.

## Contributing

PRs welcome. The whole point is auditability — please keep the codebase vanilla JS, no build step.

Third-party code is allowed but must be **vendored verbatim** under `vendor/`, with a license file alongside and a note in `vendor/README.md` recording the upstream version and source URL. Currently this is just Dark Reader.

## Acknowledgements

- **Dark Reader** ([darkreader.org](https://darkreader.org/), MIT) — powers the dark-mode engine. Vendored at `vendor/darkreader.js`.
- The JSON formatter's feature set (level controls, JSON-path display, view modes, theme cycling, `window.data` exposure) is inspired by [JSON Alexander](https://github.com/wesbos/JSON-Alexander) by Wes Bos (MIT). All code is original to ComboBreaker.

## License

MIT — see [`LICENSE`](LICENSE).
