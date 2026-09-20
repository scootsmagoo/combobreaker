# ComboBreaker privacy policy

_Last updated: 2026-09-20_

ComboBreaker does not collect, transmit, sell or share any data about you or
your browsing. There is no ComboBreaker server, account, analytics or
telemetry, and the extension loads no code from the network.

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
