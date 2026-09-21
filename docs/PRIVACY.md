# ComboBreaker privacy policy

_Last updated: 2026-09-21_

ComboBreaker does not transmit, sell or share any data about you or your
browsing. There is no ComboBreaker server, account, analytics or telemetry,
and the extension loads no code from the network. Everything it reads, it
reads on your device, for a feature you are using, and it stays there.

**What the extension handles on your device**

The Chrome Web Store asks developers to declare data an extension handles
even when it never leaves the device. In the store's categories, ComboBreaker
handles:

- **Authentication information.** The cookie editor shows, edits and deletes
  the cookies of the site you are on, which can include session tokens. If
  you switch on "Use my browser's cookies" (off by default), the cookies of a
  video site are passed to the local Helper for one download you started.
- **Web history.** The address of the tab you have the popup open on; the
  redirect chain of the page you are on (per tab, discarded when the tab
  closes); the sites you opened in a tab, remembered only so "forget this
  site when I close it" can clear them; and tab sessions you chose to save.
- **User activity.** Network requests of the page you are on are observed
  (never sent anywhere) to count blocked requests, show redirects and
  response headers, and list downloadable media.
- **Website content.** Page text and markup are read by the features that act
  on them: reader view, the SEO and structured-data viewer, link select, the
  storage viewer, the media badges and the on-page tools.

None of this is transmitted to the developer or to any third party, sold, or
used for anything but the feature you invoked.

**What is stored, and where**

- Your settings (per-site CSS/JS, dark mode, blocking level, header rules,
  privacy switches, link select options) are kept in Chrome's extension
  storage: small settings in `chrome.storage.sync`, which Chrome syncs between
  your own browsers if you have Chrome sync on; larger items (CSS/JS bodies,
  snippets, tab sessions, your blocklist) in `chrome.storage.local` on this
  device only.
- Per-tab working data (the redirect chain, response headers and media URLs of
  the page you are on) is kept in `chrome.storage.session` and discarded when
  the tab or the browser closes.
- Nothing above ever leaves your browser, except through Chrome's own sync of
  `chrome.storage.sync`, which is between you and Google.

**Network requests**

ComboBreaker makes no network requests of its own. Requests happen only as a
direct result of something you ask for: downloading a media file you chose,
Dark Reader fetching a page's own stylesheets so it can recolour them, or you
clicking a link to an external validator. The ad and tracker blocklists ship
inside the extension and are never fetched at runtime.

**Optional local helper**

Video sites that cannot be downloaded from inside the browser use the optional
ComboBreaker Helper, a program you install yourself, which runs yt-dlp on your
computer. The extension talks to it only over Chrome's native messaging, only
after you allow it, and only about downloads you start. If you switch on "Use
my browser's cookies" (off by default), the cookies of the video's site are
passed to the Helper for that one download, in a temporary file that is
deleted afterwards.

**Permissions**

Every permission and what it is used for is listed in the
[README](../README.md#privacy) and, in store-review form, in
[STORE_LISTING.md](STORE_LISTING.md).

**Contact**

Questions and reports: https://github.com/scootsmagoo/combobreaker/issues
