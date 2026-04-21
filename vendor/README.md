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
