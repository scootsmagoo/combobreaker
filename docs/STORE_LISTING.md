# Chrome Web Store listing

Everything the developer dashboard asks for, ready to paste. Written against
the manifest as of v0.11.0; if permissions change, update the table below in
the same commit.

## Publishing checklist

1. `npm run check && npm run lint && npm test`, then `npm run pack` →
   `dist/combobreaker-<version>.zip`. That zip is the upload; there is no
   separate store build (the one store-specific behaviour, no download badge
   on YouTube by default, is decided at runtime from the manifest's
   `update_url`, which only store installs have).
2. Register at https://chrome.google.com/webstore/devconsole (one-time US$5),
   **New item**, upload the zip.
3. **Store listing** tab: paste the summary and description below, category,
   language, upload the five screenshots from `docs/store/` and the 128px
   icon (`icons/icon128.png`). Also upload the two promo tiles from
   `docs/store/` (`promo-small-440x280.png`, `promo-marquee-1400x560.png`);
   they are optional, but the store only features items that have them.
   Regenerate with `node scripts/store_promo.js`.
4. **Privacy practices** tab: single purpose, the permission justifications,
   "no remote code", the data-usage answers, and the privacy policy URL
   `https://github.com/scootsmagoo/combobreaker/blob/main/docs/PRIVACY.md`.
5. **Distribution**: free, all regions, public (or unlisted for a first round).
6. Submit. Expect an in-depth review (broad host permission); days, sometimes
   longer. A rejection email names the policy; "Known review risks" below
   lists the likely ones and what to change.
7. After approval: the store install has a different extension ID from the
   unpacked one, so Helper users re-run the setup command from the setup page
   once (it carries the right ID).

## Store listing tab

**Name:** ComboBreaker

**Summary** (132 characters max; this is the manifest `description`):

> One privacy-respecting toolbox instead of a dozen small extensions: per-site JS/CSS, dark mode, dev tools, downloader. No telemetry.

**Category:** Developer Tools (alternative: Privacy & Security)

**Language:** English

**Description:**

```
ComboBreaker replaces the pile of small, single-purpose extensions most people
end up with, the ones that get sold and start shipping trackers, with one
open-source toolbox you can read end to end. No telemetry, no analytics, no
account, no server, no remotely loaded code. MIT licensed.

PRIVACY AND BLOCKING
• Ad and tracker blocking in three levels: Off, Basic (about 40 of the biggest
  ad, analytics and social-pixel companies) and Strong (about 3,500 more ad and
  tracking servers). Pause it on any one site.
• A count of blocked requests on the toolbar icon, and the popup names who was
  blocked.
• Your own blocklist: add hosts by hand, from a hosts file, or with one click
  from the tracker highlighter.
• Tracker highlighter: outlines what on the page comes from known trackers,
  marks hidden pixels and iframes, and says whether each one is being blocked.
• Per-site privacy switches: forget a site's cookies and storage when you close
  it, block third-party cookies there, limit the referrer it sends.
• Per-site JavaScript on/off.

MAKE SITES YOURS
• Dark mode (Dark Reader engine) that only darkens bright sites and leaves
  already-dark ones alone, with per-site On / Off.
• Your own CSS and JavaScript per site, and a snippets library for scripts you
  run on demand.

INSPECT AND DEBUG
• Cookie editor, localStorage / sessionStorage viewer with JSON export, and a
  one-click "clear all data for this site".
• Response headers, per-site request/response header overrides, Copy as cURL,
  and the redirect chain for the current tab.
• JSON formatter, SEO / meta tag and structured data (JSON-LD) inspector, tech
  stack detector.
• Colour picker, pixel ruler, font inspector, encoding override.
• Utility belt: JWT decoder, encoders, regex tester, timestamp and colour
  converters with a contrast checker, diff, fake data, password / UUID
  generator, QR code. All computed locally.

READ, CAPTURE, DOWNLOAD
• Link select: drag a box over a group of links to open them all in background
  tabs or copy them (press Alt+Shift+L, then drag; or hold Z and drag).
• Reader view and Copy page as Markdown.
• Full-page screenshot.
• Video downloader for direct files and HLS streams, with an optional local
  helper app (yt-dlp) for sites that need it. No DRM circumvention.
• Viewport / user-agent presets, tab session save and restore, duplicate tab
  finder.

Every setting can be exported to and restored from a single JSON file.

Source code, issue tracker and documentation:
https://github.com/scootsmagoo/combobreaker
```

**Screenshots** (1280×800, five): generated into `docs/store/` by
`node scripts/store_screenshots.js` from a staged demo news site, so they can
be regenerated after any UI change.

1. `1-popup-site.png`: popup Site tab, "Your changes here" chips, blocking level, blocked count, per-site privacy switches.
2. `2-tracker-highlighter.png`: tracker panel with blocked / not blocked hosts and a Block button.
3. `3-link-select.png`: link select mid-drag, headlines only.
4. `4-storage-viewer.png`: Cookies tab showing the localStorage viewer.
5. `5-seo-viewer.png`: SEO & structured data viewer.

## Privacy practices tab

**Single purpose:**

> ComboBreaker is a browser toolbox for the page you are on: it lets you inspect it (cookies, storage, headers, redirects, metadata), change how it looks and behaves for you (dark mode, your own CSS/JS, blocking of ad and tracking requests, per-site privacy settings), and capture or open its content (links, reader view, screenshot, media). Every feature acts on the current site at the user's request and all settings are stored locally or in the user's own Chrome sync storage.

Reviewers sometimes read a many-featured extension as "multiple purposes". The
defence is that every feature is a per-page tool behind one popup and none of
them changes browser-wide settings (the search-engine override that did was
removed in v0.8.1).

**Permission justifications:**

| Permission | Justification to paste |
|---|---|
| `storage` | Saves the user's settings (per-site CSS/JS, dark mode, blocking level, header rules, snippets, blocklist). Nothing is sent anywhere. |
| `activeTab` | Runs the on-demand tools (colour picker, ruler, font inspector, tracker highlighter, screenshot) in the tab the user invoked them on. |
| `tabs` | Reads the current tab's URL to show that site's settings in the popup; opens selected links as background tabs (link select); saves and restores tab sessions; finds duplicate tabs. |
| `windows` | Opens selected links or a restored session in a new window; resizes the window for the viewport presets. |
| `scripting` | Injects the on-demand tools, Dark Reader, the reader / SEO extractors and the storage viewer into the current tab when the user asks for them. |
| `contentSettings` (optional) | Implements the per-site "Allow JavaScript" switch using Chrome's own JavaScript content setting. Requested the first time the user flips that switch. |
| `declarativeNetRequest` | Blocks ad and tracker requests from bundled static rulesets and the user's own blocklist; applies the user's per-site request/response header rules, third-party cookie blocking and referrer policy. |
| `declarativeNetRequestFeedback` | Reads which of the extension's own block rules matched on the current tab, to show the user a "blocked on this page" count and list. |
| `webRequest` | Observes (never blocks or modifies) main-frame requests to show the redirect chain and response headers for the current tab, and notices media responses so the Media tab can list downloadable video/audio. Kept in session storage, per tab, and discarded when the tab closes. |
| `downloads` | Saves files the user chose to download: screenshots, media, storage/settings exports. |
| `cookies` | The cookie editor (view, edit, delete cookies for the current site). Optionally, and off by default, passes the current video site's cookies to the user's local helper app for a download the user started. |
| `browsingData` | "Clear all data for this site" and the per-site "forget this site when I close it" switch; always scoped to the one site the user chose. |
| `userScripts` | Runs the user's own per-site JavaScript and snippets, which the user writes in the options page. Requires the user to enable "Allow User Scripts" for the extension. |
| `nativeMessaging` (optional) | Requested from the Helper setup page, when the user chooses to set the Helper up. Talks to the optional ComboBreaker Helper, a local app the user installs separately, which runs yt-dlp for video sites that cannot be downloaded from inside the browser. Unused unless the user installs it. |
| `notifications` (optional) | Requested when the user switches on "Notify me when a download finishes" in options. Tells the user when a helper download finished or failed. |
| `clipboardWrite` (optional) | Copy actions (colour, Markdown, links, cURL) on pages where the async clipboard API is unavailable. |
| Host permission `<all_urls>` | The extension's purpose is to act on whatever site the user is on: per-site CSS/JS and dark mode must be applied at page load on the sites the user configured, the JSON formatter and link select must be available on any page, and blocking / header rules apply to requests from any site. The set of sites cannot be known in advance. |

**Remote code:** No. All code ships in the package. The user's own CSS/JS and
snippets are user-authored content run through `chrome.userScripts`, not code
fetched by the extension. The Strong blocklist is data, regenerated at build
time and shipped in the package; nothing is fetched at runtime.

**Data usage** (tick nothing; then certify the three statements):

- The extension does not collect or transmit any user data. It makes no
  network requests of its own; the only outbound requests it causes are ones
  the user asks for (downloading a media file, Dark Reader fetching a page's
  own stylesheets so it can recolour them, the user clicking through to a
  validator).
- Not sold to third parties; not used for purposes unrelated to the single
  purpose; not used for creditworthiness or lending.

**Privacy policy URL:** required when `<all_urls>` / cookies are requested:
`https://github.com/scootsmagoo/combobreaker/blob/main/docs/PRIVACY.md`

## Known review risks

- **Breadth of permissions.** Twelve required permissions plus `<all_urls>`
  guarantees an in-depth (slow) review. The three that add alarming lines to
  the install dialog (`nativeMessaging`, `contentSettings`, `notifications`)
  are optional and requested at first use. `cookies` and `browsingData` stay
  required on purpose: they add no install warning, and "forget this site when
  I close it" needs `browsingData` in the background, where Chrome cannot show
  a permission prompt. If a reviewer pushes back, `downloads` is the next
  candidate to make optional.
- **Video downloading.** The store forbids offering YouTube downloads. Store
  installs therefore show no download badge on YouTube by default
  (`content/media_overlay.js`, `STORE_INSTALL`); a user can still switch badges
  on for that site, and the separately installed Helper does the downloading,
  not the extension. Keep YouTube out of the listing text and screenshots (it
  is). If a reviewer still objects, remove the YouTube adapter from the store
  upload entirely.
- **`userScripts`.** Allowed, but reviewers check that the code it runs is
  user-authored. It is.
- **Unpacked-extension ID.** The helper's native-messaging manifest lists the
  extension ID; a store install gets a new ID, so `native/install.*` must
  accept the store ID as well (they already take the ID as an argument; the
  setup page passes the running ID, so this works unchanged).
