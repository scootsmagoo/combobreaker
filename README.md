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
| **Dark mode** | Per-site dark mode via CSS filter. Toggleable, remembers per-site. |
| **Color picker** | Native `EyeDropper` API — one click, hex copied to clipboard. |
| **Pixel ruler** | On-page draggable ruler overlay. |
| **Font inspector** | Hover any element to see its font stack, size, weight, line-height, color. |
| **JSON formatter** | Auto-pretty-prints `application/json` responses. Tree / Formatted / Raw view modes, depth-level expand buttons (1–5, All), hover for JSON path + click to pin & copy, per-node "expand all descendants", auto/dark/light theme, and `window.data` exposed in the page console. |
| **Full-page screenshot** | Scroll-and-stitch the entire page to a PNG download. |
| **Encoding override** | Manually set character encoding for legacy/garbled pages. |
| **Kagi search** | Sets Kagi as your default search provider on install. |
| **Basic adblock** | Static `declarativeNetRequest` ruleset blocking common ad/tracker domains. |

## Install (developer mode)

1. Clone this repo.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Pin ComboBreaker to your toolbar. Click the icon to open the popup.

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
background/                Service worker (commands, screenshot, content settings)
popup/                     Toolbar popup (per-site toggles, tool launchers)
options/                   Full-page options (CSS/JS editors, global prefs)
content/site_injector.js   Runs at document_start on every page; loads per-site CSS/JS
tools/                     On-demand tools (color, ruler, whatfont, darkmode)
viewer/                    JSON formatter viewer
rules/                     declarativeNetRequest rulesets
lib/                       Shared storage + URL helpers
icons/                     PNG icons
```

All settings live in `chrome.storage.sync` so they follow your Chrome profile.

## Privacy

ComboBreaker:

- Makes **zero network requests** of its own.
- Has **no analytics, no error reporting, no "anonymous usage" pings**.
- Stores per-site settings in `chrome.storage.sync` (your encrypted Google profile, not our server — we don't have one).
- Asks for `<all_urls>` only because per-site CSS/JS injection cannot work otherwise. You can audit every line of every script that runs.

## Contributing

PRs welcome. The whole point is auditability — please keep the codebase vanilla JS, no build step, no minified vendor blobs.

## Acknowledgements

The JSON formatter's feature set (level controls, JSON-path display, view modes, theme cycling, `window.data` exposure) is inspired by [JSON Alexander](https://github.com/wesbos/JSON-Alexander) by Wes Bos (MIT). All code is original to ComboBreaker.

## License

MIT — see [`LICENSE`](LICENSE).
