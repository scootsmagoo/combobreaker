# ComboBreaker

> One Chrome extension to replace a dozen sketchy ones.

ComboBreaker is a privacy-respecting consolidation of the small browser tools most of us actually use day-to-day. No telemetry. No analytics. No remote-code loading. No "we got acquired and now we sell your browsing history" surprise updates. Pinned, auditable, MIT-licensed.

It is intentionally **not** a one-for-one replacement for heavyweights like uBlock Origin, Dark Reader, or Vimium — those are huge, ongoing projects. ComboBreaker covers the simpler 80% of what most of those extensions do, in a single auditable codebase.

Inspired by the spirit of [@levelsio's combo-extension thread](https://x.com/levelsio/status/2046271694042505451).

## Features

### Privacy & blocking

| Feature | What it does |
|---|---|
| **Ad & tracker blocking** | Off / **Basic** (~40 big ad, analytics and social-pixel companies) / **Strong** (+ ~3,500 ad and tracking servers). Per-site pause, a blocked count on the toolbar icon, and the popup names who was blocked. [Details ↓](#ad--tracker-blocking) |
| **Your blocklist** | Add your own hosts, from the tracker highlighter's **Block** button or a list in options. [Details ↓](#your-blocklist) |
| **Tracker highlighter** | A visual privacy audit of the page: outlines what comes from known trackers, marks hidden pixels and iframes, and says whether each host is being blocked. [Details ↓](#tracker-highlighter) |
| **Per-site privacy** | Three switches for the site you are on: forget it when its last tab closes, block third-party cookies there, and limit the referrer it sends. [Details ↓](#per-site-privacy) |
| **Per-site JS toggle** | Disable JavaScript on a domain via `chrome.contentSettings`. Survives reloads. |

### Make sites yours

| Feature | What it does |
|---|---|
| **Dark mode** | Dark Reader, with a per-site Auto / On / Off. **Auto only darkens bright sites**; ones that are dark already are left alone. [Details ↓](#dark-mode) |
| **Per-site custom CSS** | A small Stylus-style editor; CSS is injected at `document_start` only on the matching site. |
| **Per-site custom JS** | Your own script on a domain, run in the page's world on every visit, including on strict-CSP sites. [Details ↓](#per-site-custom-js) |
| **Snippets** | **Tools → Snippets**: named JS blobs you run on the current tab with one click (the bookmarklet use case). Ships with table→CSV, un-stick fixed overlays, and re-enable text selection. |

### Inspect & debug

| Feature | What it does |
|---|---|
| **Cookies, storage, headers, redirects** | Cookie editor, localStorage / sessionStorage viewer with JSON export, one-click **Nuke all site data**, response headers with per-site header overrides and **Copy cURL**, and the redirect chain for the tab. [Details ↓](#cookies-storage-headers-redirects) |
| **JSON formatter** | Pretty-prints raw JSON responses: tree / formatted / raw views, depth controls, JSON paths, themes. [Details ↓](#json-formatter) |
| **SEO & structured data** | Title, description, canonical, Open Graph / Twitter tags, heading outline and images without `alt`, plus JSON-LD, microdata, RDFa and a JSON-LD builder. [Details ↓](#seo--structured-data) |
| **Tech stack** | Site tab → **Built with**: framework, CMS, analytics, services and hosting chips from ~75 local signatures (page globals, DOM, script URLs, response headers). No network calls. |
| **Utility belt** | JWT decoder, encoders, regex tester, timestamp and colour converters with a contrast checker, diff, fake data, password / UUID generator, QR code. All local. [Details ↓](#utility-belt) |
| **Color picker** | Native `EyeDropper` API — one click, hex copied to clipboard. |
| **Pixel ruler** | On-page draggable ruler overlay. |
| **Font inspector** | Hover any element to see its font stack, size, weight, line-height, color. |
| **Encoding override** | Manually set character encoding for legacy/garbled pages. |

### Read, capture & download

| Feature | What it does |
|---|---|
| **Video downloader** | A download badge on any video or thumbnail (YouTube, Twitter/X, plain `<video>`), a Media tab with progress, a built-in HLS downloader, and the optional **ComboBreaker Helper** (local yt-dlp) for YouTube and DASH. [Details ↓](#video-downloader) |
| **Reader view** | Clean reader tab via Mozilla Readability, and **Copy as Markdown** for notes or LLM workflows. [Details ↓](#reader-view) |
| **Full-page screenshot** | Scroll-and-stitch the entire page to a PNG download. |
| **Link select** | Hold **Z** and drag a box over a group of links to open them all in background tabs, open them in a new window, or copy them. Smart select takes just the headlines. The Linkclump idea. [Details ↓](#link-select) |
| **Browse tools** | Viewport / User-Agent presets, tab session save and restore, duplicate-tab finder, and skip-cache while the popup is open. [Details ↓](#browse-tools) |

### Housekeeping

| Feature | What it does |
|---|---|
| **Backup** | Options → **Backup**: export / import every setting (global, per-site CSS/JS/headers and privacy switches, snippets, tab sessions, your blocklist) as one JSON file. |

## Feature details

The longer story for the features above that need one. The video downloader and dark mode go deeper under Architecture: [Video downloader internals](#video-downloader-internals), [Dark-mode model](#dark-mode-model).

### Ad & tracker blocking

Three levels, set from the popup's Site tab: **Off**, **Basic** (a hand-picked `declarativeNetRequest` list of ~40 of the biggest ad, analytics and social-pixel companies; very unlikely to break anything) and **Strong** (Basic plus [Peter Lowe's list](https://pgl.yoyo.org/adservers/) of ~3,500 ad and tracking servers, third-party requests only). **Pause on this site** switches blocking off for one site, e.g. when something breaks or you need its analytics / tag manager to load. The toolbar icon shows how many requests were blocked on the current page (switch it off in options) and the Site tab names the companies. It blocks network requests only: no cosmetic filtering, no YouTube ads. Run uBlock Origin Lite alongside if you want those. The Strong list is regenerated weekly by `.github/workflows/blocklist.yml`, which opens a PR (or run `node scripts/update_blocklist.js` yourself); the extension never fetches it at runtime.

### Your blocklist

Extra hosts to block, added with the highlighter's **Block** button or edited in Options → **Your blocklist** (one per line; URLs and `*.` prefixes are accepted, IPs and junk are dropped). One dynamic DNR rule, third-party only, so opening a blocked host directly still works. Follows the blocking level (nothing on Off) and per-site pause. Local to the device, included in Backup.

### Tracker highlighter

**Tools → Show trackers**: a visual privacy audit of the page. Outlines images and frames from hosts on the Basic / Strong lists, marks hidden third-party pixels and iframes, and lists every tracker host (scripts and fetch/beacon requests included) with whether your current blocking level stops it. Click a row to scroll to it; **Block** adds a host that is getting through to your blocklist; Esc closes.

### Per-site privacy

Site tab, three switches for the site you are on. **Forget this site when I close it**: when its last tab closes, the same wipe as *Nuke all site data* runs (also swept at browser start, since quitting can outrun the cleanup). **Block third-party cookies here**: requests the site's pages make to other companies go out without cookies and cannot set any (DNR header rules; link navigations are untouched, requests from inside third-party iframes are not covered). **Referrer sent by this site**: origin only / nothing to other sites / never, as a `Referrer-Policy` response header plus a `Referer` strip for the strict options.

### Dark mode

Powered by [Dark Reader](https://darkreader.org/) (vendored, MIT). One global switch plus a per-site **Auto / On / Off**. With the switch on, **Auto darkens only bright sites**: a page that is dark already (its own dark theme, or following your system) is measured and left alone; the popup says which it decided, with a **Re-check** link. Brightness / contrast / sepia / grayscale / mode sliders in the popup and options.

### Per-site custom JS

Run your own script on a domain, in the page's MAIN world (no `GM_*` API). Delivered through `chrome.userScripts`, which works even on strict-CSP sites — turn on **Allow User Scripts** for ComboBreaker at `chrome://extensions` → Details. Without that switch it falls back to `chrome.scripting`, which runs slightly later and is subject to the page's CSP.

### Cookies, storage, headers, redirects

**Cookies** tab: list, edit, or delete cookies for the current site, switch to **Local storage** / **Session storage** to view (JSON pretty-printed), copy, edit, add, delete or **Export** keys as JSON and see the page's IndexedDB / Cache Storage names, plus **Nuke all site data** (cookies, localStorage, IndexedDB, Cache Storage, service workers — DevTools' “Clear site data” in one click). **Headers** tab: recent response header captures, **Copy cURL** (repeats the request from a terminal with your request-header overrides, never cookies), plus quick link to your request/response **header overrides** in options. **Redirects** tab: redirect chain for the current tab, copy, clear.

### JSON formatter

Auto-pretty-prints `application/json` responses. Tree / Formatted / Raw view modes, depth-level expand buttons (1–5, All), hover for JSON path + click to pin & copy, per-node "expand all descendants", auto/dark/light theme, and `window.data` exposed in the page console.

### SEO & structured data

**Browse** → **View SEO & structured data**: a **Meta & SEO** section (title and description with lengths, canonical, robots, lang, viewport, Open Graph / Twitter tags, heading outline, link counts, images missing `alt`, with rule-of-thumb check chips), then list every `<script type="application/ld+json">` block, summarize `@type`, pretty-print, copy, heuristic notes, microdata and RDFa summaries, and **links to Google’s Rich Results Test and the Schema.org validator** for the current tab URL. Includes a small **JSON-LD builder** (common types) to generate and copy markup — all local; optional validator links are the only use of the network.

### Utility belt

Tucked into the **Tools** tab — JWT decoder, encoder/decoder (Base64 / Base64-URL / URL / hex / HTML entity), regex tester with live highlights, Unix-timestamp ↔ ISO-date converter, color converter (hex / rgb / hsl / oklch) with WCAG contrast checker, line/word diff viewer, fake data + lorem-ipsum generator, password / UUID generator, and a locally rendered QR code for the current URL. Each tool is a `<details>` collapsible — open only what you need. Client-side only; no network.

### Video downloader

Hover any video player or thumbnail and a small **download badge** appears on it (YouTube feeds and players, Twitter/X videos and GIFs, any `<video>`). Click to download, or open the caret for quality presets. The **Media** tab in the popup lists the videos on the page with thumbnails and a "find on page" action, shows download progress, and keeps the raw sniffed-URL list. Direct files go through `chrome.downloads`; HLS has an in-extension downloader; YouTube, DASH and split-audio HLS use the **ComboBreaker Helper**, a one-time install that runs yt-dlp locally (see below).

### Reader view

**Browse** tab: extract the main article with [Mozilla Readability](https://github.com/mozilla/readability) and open a clean **reader** tab. Optional **Copy as Markdown** uses [Turndown](https://github.com/mixmark-io/turndown) for notes or LLM workflows. Vendored under `vendor/`.

### Link select

Hold the trigger and drag a box over links; let go and they all open in background tabs right after the current one, in page order. The trigger is **Z + drag** by default; Options → **Link select** offers Shift + drag, Alt + drag and right-button drag, and picks what happens on release (tabs, new window, or copy as URLs / title-tab-URL / a Markdown list). While dragging, **T**, **W** and **C** switch between tabs, window and copy for that one drag, **S** turns smart select on or off, **Esc** cancels, and holding the pointer at an edge scrolls the page so the box can cover more than a screen. **Smart select**: when the box holds both headline links (inside a heading, or bold) and ordinary ones, only the headlines are taken, so a news front page or search results give you the stories without their "comments" and "share" links. Duplicates, `javascript:` / `mailto:` links and links to a spot on the same page are dropped; more than 25 links asks first and 100 is the cap. With the right-button trigger on macOS and Linux the context menu needs a second right-click, because those systems open it on press rather than release.

### Browse tools

**Viewport / User-Agent** presets (resize window + optional UA for this site via DNR), **tab session** save/restore, **find duplicate** URLs and close extras, and **skip cache** for the current tab’s requests while the popup is open (see service worker for details).

## Install (developer mode)

Until ComboBreaker is published to the Chrome Web Store, side-load it as an unpacked extension:

1. Clone this repo to a stable location (Chrome reloads the extension from the same folder path on every restart, so don’t put it somewhere you’ll later move or delete).
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** (top left) and select the repo folder — the one containing `manifest.json`, not a parent or subfolder.
5. The extension appears in your list as "ComboBreaker." If the manifest has an error, Chrome shows it in red — click **Errors** for details.
6. Pin it: click the puzzle-piece icon in the Chrome toolbar, find ComboBreaker, click the pin icon next to it.

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

### Checks

The extension has no build step and no runtime dependencies; `package.json` only holds dev tooling.

```
npm install
npm run check    # manifest references, DNR rule ids, import paths, UTF-8/no-BOM
npm run lint     # ESLint
npm test         # node:test unit tests (storage, backup, site helpers, DNR rule builders, tech signatures,
                 # blocklist, cURL, HLS playlist parser, media classifier, link select)
npm run pack     # dist/combobreaker-<version>.zip with only runtime files
```

Browser smoke tests (need `npm i --no-save puppeteer-core` and a local Chrome):

```
node scripts/smoke_site.js      # per-site CSS/JS, userScripts + fallback, snippets, site-data nuke, backup
node scripts/smoke_overlay.js   # download badge on a local page and on YouTube
node scripts/smoke_links.js     # link select with real mouse + keyboard: smart select, T/W/C/S/Esc, right-button trigger, auto-scroll
node scripts/smoke_hls.js       # built-in HLS downloader: TS playlist, fMP4 byte ranges (server honours / ignores Range)
node scripts/smoke_dark.js      # dark mode Auto: bright / dark / late CSS / late-rendering app / cached verdicts / overrides
node scripts/smoke_privacy.js   # redirect chain, blocked counter, personal blocklist, third-party cookie strip, referrer override, auto-clear on close
```

CI (`.github/workflows/ci.yml`) runs check, lint, test and pack on every push.

Source files are UTF-8 without BOM, LF line endings (`.editorconfig`, `.gitattributes`).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+C` | Open popup |
| `Alt+Shift+D` | Toggle dark mode for current site |
| `Alt+Shift+C` | Pick a color from the page |
| `Z` + drag | Link select (not a Chrome shortcut: change it in Options → Link select) |
| *(unset)* | Toggle JavaScript for the current site |
| *(unset)* | Nuke all site data for the current site, then reload. Destructive and asks nothing, so it has no key until you give it one. |

You can rebind these in `chrome://extensions/shortcuts`.

## Architecture

```
manifest.json                 MV3 manifest, permissions, DNR rulesets, commands
background/service_worker.js  Boot, message router, per-site JS toggle, keyboard commands
background/*.js               One module per area: dark_mode, page_tools (tool launcher, screenshot,
                              encoding), blocking, site_data (nuke, auto-clear), net_capture (redirects,
                              response headers), tech_detect, header_rules, media, browse
popup/popup.js                Toolbar popup: init, tab routing, Site pane, dark mode, Tools
popup/panes/*.js              Cookies, Headers, Redirects, Media and Browse panes
popup/shared.js               Popup state + DOM / messaging helpers shared by the panes
popup/utilities.js            Tier-2 utility-belt tools (lazy-rendered per <details>)
options/                      Full-page options (CSS/JS editors, global prefs, dark mode)
content/site_injector.js      document_start: per-site CSS/JS, dark anti-flash
content/json_formatter.js     Pretty-printer for JSON response bodies
content/media_finder.js       DOM scan for video URLs
content/media_overlay.js      On-page download badge (all frames, shadow DOM, site adapters)
content/page_hooks.js         MAIN-world fetch/XHR hook on Twitter/X for direct MP4 variants
background/ytdlp_bridge.js    Native-messaging client for the Helper, job table, progress fan-out
background/helper_installer.js Fills in native/install.cmd and hands it to chrome.downloads (Windows)
native/                       The Helper: native messaging host (Node) + one-line installers
viewer/helper_setup.*         Setup page: OS-specific step, polls until the Helper answers
lib/helper.js                 Helper constants (source URL, install one-liner, folders)
content/schema_inject.js      Injected to collect meta / SEO tags, JSON-LD, microdata and RDFa for the viewer
content/reader_inject.js      Injected with Readability + Turndown for reader / Copy as Markdown
content/link_select.js        Link select: trigger, selection box, smart select, auto-scroll (top frame of every page)
content/dr_amd_guard_*.js     Wrapped around the Dark Reader injection (hide define.amd for that instant)
tools/                        On-demand: color picker, ruler, whatfont, tracker highlighter
viewer/                       hls_downloader, reader, structured_data
vendor/                       Dark Reader, qrcode-generator, Readability, Turndown
rules/                        declarativeNetRequest static rules: basic_block.json (hand-picked),
                              strong_block.json (generated by scripts/update_blocklist.js)
background/user_scripts.js    Per-site JS + snippets via chrome.userScripts (scripting fallback)
popup/snippets.js             Snippets library UI
popup/storage_view.js         localStorage / sessionStorage viewer in the Cookies tab
lib/                          storage (sync/local split, migrations), backup, site URL helpers
lib/site_rules.js             Pure builders for per-site DNR rules (header overrides, cookie strip, referrer)
lib/tech.js                   Tech stack signatures + matcher
lib/trackers.js               Host → blocklist lookup for the tracker highlighter, personal blocklist validation
lib/curl.js                   "Copy cURL" command builder
lib/links.js                  Link select: settings, link cleaning / de-duplication, copy formats
lib/hls.js                    .m3u8 parser (master / media, byte ranges, encryption, init segments)
lib/media.js                  Media classification by URL / MIME, stream-segment filter, download file names
test/                         node:test unit tests (fake chrome.storage)
scripts/                      check_manifest, pack, icon build, puppeteer smoke tests
icons/                        PNG icons
```

Small settings live in `chrome.storage.sync` so they follow your Chrome profile. Per-site CSS/JS bodies live in `chrome.storage.local` (`sitecode:<host>`) because sync caps each item at ~8 KB; they stay on this device, so use Options → Backup to move them. Snippets, tab sessions, your blocklist (`cb_custom_block`), dark mode's per-site Auto verdicts (`cb_dark_detect`, a cache, not in Backup) and DNR bookkeeping are also local; per-tab captures (redirects, headers, media, which auto-clear sites a tab has shown) are in `chrome.storage.session`.

### Video downloader internals

#### On-page badge

`content/media_overlay.js` runs in every frame and draws one floating badge
(in a closed shadow root, so page CSS can't touch it and the page DOM is never
modified) over whatever video-ish thing is under the pointer:

- **YouTube**: the player on watch/shorts/embed pages, and every thumbnail on
  home, search, subscriptions, sidebars and channel pages. Click = download
  that video through the Helper; the caret offers Best / 1080p / 720p /
  480p / Audio-only (MP3). Without the Helper, the click shows a one-time
  setup prompt instead.
- **Twitter / X**: `content/page_hooks.js` (page world) wraps `fetch`/XHR on
  `/i/api/graphql/*` and lifts `video_info.variants` out of the timeline JSON,
  so each tweet's video maps to its direct MP4s at every bitrate. Click =
  best MP4 via `chrome.downloads`, no HLS, no yt-dlp needed. GIFs work too.
- **Everything else**: any `<video>` with a real `src`/`<source>` downloads
  directly. Blob-backed players fall back to the HLS/DASH manifests the
  network sniffer saw for that tab, then to "download this page via the Helper".

Turn badges off globally in Options → Downloads, or per site from the badge
menu ("Hide badges on this site") or the popup's Media tab.

#### Media tab

- **Videos on this page**: what the badge would offer, as a list with
  thumbnails. Click a title or thumbnail to scroll to it and flash it.
- **Helper downloads**: live progress, cancel, "Folder" to reveal the file,
  retry on failure.
- **Raw media URLs**: the old flat list (DOM scan + `webRequest` sniff), still
  useful for odd players.

#### The Helper (one-time install, needed for YouTube)

YouTube's streams are signed and the signing scheme changes constantly; the
only maintainable way to download them without a third-party service is to
let **yt-dlp** do it. The **ComboBreaker Helper** is a native-messaging host
(`native/host.js`) plus private copies of Node, Python + yt-dlp's zip build,
and a static ffmpeg, all in one folder in the user's profile. Nothing else on
the machine is touched, and nothing is sent anywhere but the video site.

Setup is designed for people who never open a terminal on purpose:

1. Clicking a YouTube badge (or "Set up" in the popup / options) opens the
   **setup page** (`viewer/helper_setup.html`).
2. **macOS / Linux**: one line to paste into Terminal
   (`curl … install.sh | bash -s -- <extension-id>`), pre-filled with the
   extension id. **Windows**: a "Download the installer" button saves
   `Install ComboBreaker Helper.cmd` with the id baked in; double-click it.
3. The setup page polls and turns green when the Helper answers. No browser
   restart.

After that the badge and the Media tab download through it with progress;
it also handles DASH, fMP4 HLS with separate audio, and AES-128 HLS. When a
download fails in a way that smells like YouTube changed something, the host
runs yt-dlp's self-update and retries once; it also checks for an update once
a day in the background, and there is an **Update yt-dlp** button in options.
`node scripts/smoke_helper.js [--download]` answers "is the Helper broken?"
from a terminal without a browser. If YouTube answers "sign in to confirm you're not a bot",
turn on **Use my browser's cookies** in options: the extension exports the
site's cookies (via `chrome.cookies`, already decrypted, no keychain prompt)
into a per-download temp file for yt-dlp. Details, layout and the wire
protocol are in [`native/README.md`](native/README.md).

#### Built-in paths (no Helper)

- **Direct files** (mp4, webm, mov, mkv, mp3, m4a, …): `chrome.downloads`
  into a `combobreaker/` subfolder.
- **HLS** (`.m3u8`): `viewer/hls_downloader.html` parses the playlist, fetches
  segments, and writes a single `.ts`, or `.mp4` for fMP4 renditions (init
  segment + segments). Byte-range playlists (`#EXT-X-BYTERANGE`, one media
  file addressed in pieces) are fetched range by range. Separate audio renditions are not muxed; the page says
  so and offers the Helper when installed.
- **DASH** (`.mpd`): detection only.

#### Caveats

- **No DRM** anywhere (Widevine/FairPlay content stays where it is).
- **Live streams** only see the current playlist window in the built-in HLS path.
- **YouTube** needs the Helper; yt-dlp updates itself when YouTube breaks it.
- **Unsigned installers**: there is no Apple/Microsoft code-signing certificate,
  so macOS gets a Terminal one-liner (a downloaded script would hit Gatekeeper)
  and Windows shows a SmartScreen "More info → Run anyway" once.

### Dark-mode model

- **Global** switch (popup → Dark mode) × **This site** (Auto / On / Off) × **tuning** in options or the popup.
- **Off** globally: nothing is darkened unless a site is set to On.
- **On** globally, site on **Auto**: `content/site_injector.js` measures the page (what is painted behind five points of the viewport, the canvas background, `color-scheme`) and only loads Dark Reader when it is bright. The verdict is cached per site in `chrome.storage.local` (`cb_dark_detect`) so a bright site is darkened from `document_start` on the next visit with no flash; a cached "dark" is re-measured on every load, a cached "bright" expires after 7 days or on **Re-check**. Options → Dark mode → **Skip sites that are already dark** turns the measuring off (every Auto site is darkened).
- `Alt+Shift+D` flips the per-site override; on a site Auto left alone it forces Dark Reader **on**.
- Dark Reader is injected with a small guard that hides an AMD loader's `define.amd` for that instant, otherwise its UMD wrapper registers as an AMD module on RequireJS sites and never creates `window.DarkReader`.

## Privacy

ComboBreaker:

- Makes **zero** tracking or analytics network requests of its own.
- Stores your settings in `chrome.storage.sync` (or session/local where explicitly stated); there is no ComboBreaker server.
- Asks for `<all_urls>` so per-site CSS/JS and tools can work on the pages you choose.
- `nativeMessaging` is only used for the ComboBreaker Helper, which you install yourself and which only ever runs its local `yt-dlp`.
- `cookies` is used for the Cookies tab and the optional "Use my browser's cookies" download setting (off by default).
- `browsingData` is used for **Nuke all site data** and **Forget this site when I close it**, and only ever for the one site you chose.
- `scripting` runs the on-demand tools, the storage viewer and the tech / SEO probes in the current tab; what they read stays in the popup or viewer page.
- `notifications` is used for finished or failed Helper downloads and the optional nuke shortcut.
- `declarativeNetRequestFeedback` only lets the popup read which of its own block rules fired on the current tab, for the blocked count.

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
