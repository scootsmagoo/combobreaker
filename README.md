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
| **Video downloader** | Hover any video player or thumbnail and a small **download badge** appears on it (YouTube feeds and players, Twitter/X videos and GIFs, any `<video>`). Click to download, or open the caret for quality presets and copy helpers. The **Media** tab in the popup lists the videos on the page with thumbnails and a "find on page" action, shows yt-dlp job progress, and keeps the raw sniffed-URL list. Direct files go through `chrome.downloads`; HLS has an in-extension downloader; YouTube, DASH and split-audio HLS use the optional **yt-dlp bridge** (a local native-messaging host, see below). |
| **Reader view** | **Browse** tab: extract the main article with [Mozilla Readability](https://github.com/mozilla/readability) and open a clean **reader** tab. Optional **Copy as Markdown** uses [Turndown](https://github.com/mixmark-io/turndown) for notes or LLM workflows. Vendored under `vendor/`. |
| **Structured data (JSON-LD)** | **Browse** → **View structured data**: list every `<script type="application/ld+json">` block, summarize `@type`, pretty-print, copy, heuristic notes, microdata and RDFa summaries, and **links to Google’s Rich Results Test and the Schema.org validator** for the current tab URL. Includes a small **JSON-LD builder** (common types) to generate and copy markup — all local; optional validator links are the only use of the network. |
| **Encoding override** | Manually set character encoding for legacy/garbled pages. |
| **Cookies, headers, redirects** | **Cookies** tab: list, edit, or delete cookies for the current site. **Headers** tab: recent response header captures plus quick link to your request/response **header overrides** in options. **Redirects** tab: redirect chain for the current tab, copy, clear. |
| **Browse tools** | **Viewport / User-Agent** presets (resize window + optional UA for this site via DNR), **tab session** save/restore, **find duplicate** URLs and close extras, and **skip cache** for the current tab’s requests while the popup is open (see service worker for details). |
| **Utility belt** | Tucked into the **Tools** tab — JWT decoder, encoder/decoder (Base64 / Base64-URL / URL / hex / HTML entity), regex tester with live highlights, Unix-timestamp ↔ ISO-date converter, color converter (hex / rgb / hsl / oklch) with WCAG contrast checker, line/word diff viewer, fake data + lorem-ipsum generator, password / UUID generator, and a locally rendered QR code for the current URL. Each tool is a `<details>` collapsible — open only what you need. Client-side only; no network. |
| **Kagi search** | Sets Kagi as your default search provider on install. |
| **Basic adblock** | Static `declarativeNetRequest` ruleset blocking common ad/tracker domains. |

## Install (developer mode)

Until ComboBreaker is published to the Chrome Web Store, side-load it as an unpacked extension:

1. Clone this repo to a stable location (Chrome reloads the extension from the same folder path on every restart, so don’t put it somewhere you’ll later move or delete).
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** (top left) and select the repo folder — the one containing `manifest.json`, not a parent or subfolder.
5. The extension appears in your list as "ComboBreaker." If the manifest has an error, Chrome shows it in red — click **Errors** for details.
6. Pin it: click the puzzle-piece icon in the Chrome toolbar, find ComboBreaker, click the pin icon next to it.

On first install Chrome will prompt to confirm the search-provider override (Kagi). Decline if you don’t want that.

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

- **Popup**: right-click the toolbar icon → **Inspect popup**. DevTools are scoped to the popup.
- **Service worker** (`background/`): on the `chrome://extensions` card, click the **service worker** link to open DevTools for it. MV3 service workers go idle after ~30s — interact with the extension to wake them.
- **Content scripts** (`content/site_injector.js`, anything in `tools/`): open DevTools on the target page (`Cmd+Opt+I` on macOS), then in the Console’s top-left context dropdown, switch from "top" to the ComboBreaker content-script context.
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
manifest.json                 MV3 manifest, permissions, DNR, settings overrides
background/                   Service worker (commands, screenshot, content settings,
                              Dark Reader injection, media list, header rules, etc.)
popup/                        Toolbar popup (toggles, Cookies/Headers/Redirects/Media/
                              Browse/Tools, utility belt)
popup/utilities.js            Tier-2 utility-belt tools (lazy-rendered per <details>)
options/                      Full-page options (CSS/JS editors, global prefs, dark mode)
content/site_injector.js      document_start: per-site CSS/JS, dark anti-flash
content/json_formatter.js     Pretty-printer for JSON response bodies
content/media_finder.js       DOM scan for video URLs
content/media_overlay.js      On-page download badge (all frames, shadow DOM, site adapters)
content/page_hooks.js         MAIN-world fetch/XHR hook on Twitter/X for direct MP4 variants
background/ytdlp_bridge.js    Native-messaging client for the yt-dlp host, job table, progress fan-out
native/                       yt-dlp native messaging host (Node) + installers
content/schema_inject.js      Injected to collect JSON-LD / microdata / RDFa for structured-data viewer
content/reader_inject.js      Injected with Readability + Turndown for reader / Copy as Markdown
tools/                        On-demand: color picker, ruler, whatfont
viewer/                       hls_downloader, reader, structured_data
vendor/                       Dark Reader, qrcode-generator, Readability, Turndown
rules/                        declarativeNetRequest static rules
lib/                          storage + site URL helpers
icons/                        PNG icons
```

All settings you change in the UI live in `chrome.storage.sync` (except a few per-window/session bits noted in the code) so they follow your Chrome profile.

### Video downloader

#### On-page badge

`content/media_overlay.js` runs in every frame and draws one floating badge
(in a closed shadow root, so page CSS can't touch it and the page DOM is never
modified) over whatever video-ish thing is under the pointer:

- **YouTube**: the player on watch/shorts/embed pages, and every thumbnail on
  home, search, subscriptions, sidebars and channel pages. Click = download
  that video through the yt-dlp bridge; the caret offers Best / 1080p / 720p /
  480p / Audio-only (MP3).
- **Twitter / X**: `content/page_hooks.js` (page world) wraps `fetch`/XHR on
  `/i/api/graphql/*` and lifts `video_info.variants` out of the timeline JSON,
  so each tweet's video maps to its direct MP4s at every bitrate. Click =
  best MP4 via `chrome.downloads`, no HLS, no yt-dlp needed. GIFs work too.
- **Everything else**: any `<video>` with a real `src`/`<source>` downloads
  directly. Blob-backed players fall back to the HLS/DASH manifests the
  network sniffer saw for that tab, then to "yt-dlp this page".

Turn badges off globally in Options → Downloads, or per site from the badge
menu ("Hide badges on this site") or the popup's Media tab.

#### Media tab

- **Videos on this page**: what the badge would offer, as a list with
  thumbnails. Click a title or thumbnail to scroll to it and flash it.
- **yt-dlp downloads**: live progress, cancel, "Folder" to reveal the file,
  retry on failure.
- **Raw media URLs**: the old flat list (DOM scan + `webRequest` sniff), still
  useful for odd players.

#### yt-dlp bridge (optional)

YouTube's streams are signed and the signature scheme changes constantly;
the only maintainable way to download them without a third-party service is
to let **yt-dlp** do it. `native/` contains a small Node native-messaging host
and installers; see [`native/README.md`](native/README.md). Once registered,
the badge and the Media tab download through it with progress, and it also
handles DASH, fMP4 HLS with separate audio, and AES-128 HLS. Without it, the
badge copies a ready-to-paste `yt-dlp "<url>"` command instead.

#### Built-in paths (no bridge)

- **Direct files** (mp4, webm, mov, mkv, mp3, m4a, …): `chrome.downloads`
  into a `combobreaker/` subfolder.
- **HLS** (`.m3u8`): `viewer/hls_downloader.html` parses the playlist, fetches
  segments, and writes a single `.ts`, or `.mp4` for fMP4 renditions (init
  segment + segments). Separate audio renditions are not muxed; the page says
  so and offers the bridge when installed.
- **DASH** (`.mpd`): detection only.

#### Caveats

- **No DRM** anywhere (Widevine/FairPlay content stays where it is).
- **Live streams** only see the current playlist window in the built-in HLS path.
- **YouTube** needs the bridge; expect yt-dlp to need updating now and then.

### Dark-mode model

Same idea as stock Dark Reader: global default + per-site override.

- **Global** (popup → dark mode) vs **This site** (Auto / On / Off) vs **tuning** in options or the popup.
- `Alt+Shift+D` flips the per-site override the same way Dark Reader does.

## Privacy

ComboBreaker:

- Makes **zero** tracking or analytics network requests of its own.
- Stores your settings in `chrome.storage.sync` (or session/local where explicitly stated); there is no ComboBreaker server.
- Asks for `<all_urls>` so per-site CSS/JS and tools can work on the pages you choose.
- `nativeMessaging` is only used for the optional yt-dlp bridge, which you install yourself and which only ever runs your local `yt-dlp`.

## Contributing

PRs welcome. Please keep the codebase **vanilla JS, no build step** unless a future change justifies it.

Vendored third-party code must live under `vendor/` with a license file and a short note in `vendor/README.md` (version + upstream URL). See that file for the current list.

## Acknowledgements

- **Dark Reader** ([darkreader.org](https://darkreader.org/), MIT) — dark mode. `vendor/darkreader.js`
- **qrcode-generator** ([github](https://github.com/kazuhikoarase/qrcode-generator), MIT) — QR in the utility belt. `vendor/qrcode-generator.js`
- **Readability** ([github](https://github.com/mozilla/readability), Apache-2.0) — article extraction for reader view. Vendored with `Readability.LICENSE`
- **Turndown** ([github](https://github.com/mixmark-io/turndown), MIT) — HTML → Markdown for **Copy as Markdown**. Vendored with `turndown.LICENSE`
- The JSON formatter UX is **inspired by** [JSON Alexander](https://github.com/wesbos/JSON-Alexander) (Wes Bos, MIT). Implementation is original to ComboBreaker.

## License

MIT — see [`LICENSE`](LICENSE).
