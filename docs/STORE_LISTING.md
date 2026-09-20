# Chrome Web Store listing

Everything the developer dashboard asks for, ready to paste. Written against
the manifest as of v0.10.1; if permissions change, update the table below in
the same commit.

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

**Screenshots** (1280×800 or 640×400, up to five). Suggested set:

1. Popup, Site tab on a news site: "Your changes here" chips, dark mode, blocking level, blocked count.
2. Tracker highlighter panel over a page, with blocked / not blocked rows.
3. Link select mid-drag on a list of headlines.
4. Cookies tab showing the localStorage viewer.
5. SEO & structured data viewer.

`scripts/smoke_*.js` already drive all five states in a real browser and can
write PNGs (`smoke_links.js <dir>` does); crop those rather than staging shots
by hand.

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
| `contentSettings` | Implements the per-site "Allow JavaScript" switch using Chrome's own JavaScript content setting. |
| `declarativeNetRequest` | Blocks ad and tracker requests from bundled static rulesets and the user's own blocklist; applies the user's per-site request/response header rules, third-party cookie blocking and referrer policy. |
| `declarativeNetRequestFeedback` | Reads which of the extension's own block rules matched on the current tab, to show the user a "blocked on this page" count and list. |
| `webRequest` | Observes (never blocks or modifies) main-frame requests to show the redirect chain and response headers for the current tab, and notices media responses so the Media tab can list downloadable video/audio. Kept in session storage, per tab, and discarded when the tab closes. |
| `downloads` | Saves files the user chose to download: screenshots, media, storage/settings exports. |
| `cookies` | The cookie editor (view, edit, delete cookies for the current site). Optionally, and off by default, passes the current video site's cookies to the user's local helper app for a download the user started. |
| `browsingData` | "Clear all data for this site" and the per-site "forget this site when I close it" switch; always scoped to the one site the user chose. |
| `userScripts` | Runs the user's own per-site JavaScript and snippets, which the user writes in the options page. Requires the user to enable "Allow User Scripts" for the extension. |
| `nativeMessaging` | Talks to the optional ComboBreaker Helper, a local app the user installs separately, which runs yt-dlp for video sites that cannot be downloaded from inside the browser. Unused unless the user installs it. |
| `notifications` | Tells the user when a helper download finished or failed. |
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

**Privacy policy URL:** the store requires one when `<all_urls>` / cookies are
requested. The README's Privacy section is the policy; link to
`https://github.com/scootsmagoo/combobreaker#privacy`.

## Known review risks

- **Breadth of permissions.** Fifteen required permissions plus `<all_urls>`
  guarantees an in-depth (slow) review. Moving `cookies`, `browsingData`,
  `nativeMessaging` and `notifications` to `optional_permissions`, requested
  the first time the feature is used, would shorten the install warning and
  the review. Not done yet: it needs a request flow per feature, and the
  auto-clear feature runs in the background where a permission prompt cannot
  be shown.
- **Video downloading.** The store forbids downloading YouTube video. The
  in-browser paths never touch YouTube (it needs the separately installed
  helper), but the badge does appear on YouTube pages. For a store build,
  hide the badge on YouTube hosts unless the helper is installed, and keep
  YouTube out of the listing text and screenshots.
- **`userScripts`.** Allowed, but reviewers check that the code it runs is
  user-authored. It is.
- **Unpacked-extension ID.** The helper's native-messaging manifest lists the
  extension ID; a store install gets a new ID, so `native/install.*` must
  accept the store ID as well (they already take the ID as an argument; the
  setup page passes the running ID, so this works unchanged).
