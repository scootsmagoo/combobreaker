# vendor/

Third-party code, vendored verbatim.

## darkreader.js

- **Source**: https://github.com/darkreader/darkreader
- **Version**: v4.9.120
- **Bundle**: https://unpkg.com/darkreader@4.9.120/darkreader.js (UMD, exposes `window.DarkReader`)
- **License**: MIT — see `darkreader.LICENSE`

ComboBreaker uses Dark Reader as its dark-mode engine. The bundle is loaded into the page world (`world: "MAIN"`) on demand, only when dark mode is enabled for a site.

To upgrade:

```bash
curl -sSL -o vendor/darkreader.js https://unpkg.com/darkreader@<new-version>/darkreader.js
curl -sSL -o vendor/darkreader.LICENSE https://raw.githubusercontent.com/darkreader/darkreader/v<new-version>/LICENSE
```

Then update the version number in this file.

## qrcode-generator.js

- **Source**: https://github.com/kazuhikoarase/qrcode-generator
- **Version**: 1.4.4
- **Bundle**: https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js (UMD, exposes `window.qrcode` — also a CommonJS export which the popup ignores).
- **License**: MIT — see `qrcode-generator.LICENSE` (the upstream repo carries the license header inside each source file rather than a top-level `LICENSE`, so a copy of the standard MIT text crediting Kazuhiko Arase is bundled here).

Used by the **QR code** utility under the popup's Tools tab to render the current page URL as a QR code on a `<canvas>`. Loaded as a classic script in `popup.html` (no network calls).

To upgrade:

```bash
curl -sSL -o vendor/qrcode-generator.js https://cdn.jsdelivr.net/npm/qrcode-generator@<new-version>/qrcode.js
```

Then update the version number in this file.

## Readability.js

- **Source**: https://github.com/mozilla/readability
- **Version**: 0.5.0 (npm `@mozilla/readability`, file `Readability.js`)
- **License**: Apache-2.0 — see `Readability.LICENSE` and the header in `Readability.js`

Used in the service worker to extract the main article from the current tab before opening **reader view** or **Copy as Markdown** (with Turndown). Injected with `scripting.executeScript` in the **isolated** world before a small `func` runs; not loaded on every page.

## turndown.js

- **Source**: https://github.com/mixmark-io/turndown
- **Version**: 7.2.0 (UMD build `lib/turndown.browser.umd.js` saved as `turndown.js`)
- **License**: MIT — see `turndown.LICENSE` and the upstream repository

Paired with Readability to turn cleaned article HTML into Markdown. Exposes `window.TurndownService` in the isolated world.

To upgrade (from a throwaway `npm i` run):

```bash
cp node_modules/turndown/lib/turndown.browser.umd.js vendor/turndown.js
```

Then update the version in this file.
