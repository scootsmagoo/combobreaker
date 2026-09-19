// Runs at document_start on every page (top frame only, isolated world).
// Responsibilities:
//   1. Look up site + global settings from chrome.storage.sync, and the
//      site's css/js bodies from chrome.storage.local (see lib/storage.js).
//   2. Inject per-site user CSS via a <style> on documentElement.
//   3. Per-site user JS: normally delivered by chrome.userScripts (see
//      background/user_scripts.js). When that API is unavailable we ask the
//      service worker to run it via chrome.scripting in the MAIN world. (An
//      inline <script> created here does NOT work: MV3 applies the extension's
//      own CSP to it.)
//   4. Decide whether dark mode should be on, drop an anti-flash preamble,
//      and ask the service worker to load Dark Reader into the page world.
//      In "Auto" (no per-site override, global switch on) the page is first
//      checked for being dark already; see "Already-dark detection" below.
//   5. React to live storage changes (popup / options toggles) without a reload.

(() => {
  if (window.__cb_injected) return;
  window.__cb_injected = true;

  const STYLE_ID_USER = "__cb_user_css__";
  const STYLE_ID_DARK_PREAMBLE = "__cb_dark_preamble__";
  const USERSCRIPT_SITES_KEY = "cb_userscript_sites";
  const DETECT_KEY = "cb_dark_detect"; // storage.local: { [site]: { dark: boolean, at: ms } }
  const BRIGHT_TTL_MS = 7 * 24 * 3600 * 1000;
  const DETECT_MAX_SITES = 500;

  function siteKey() {
    let host = location.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host || null;
  }

  function siteItemKey(s) {
    return `site:${s}`;
  }

  function siteCodeKey(s) {
    return `sitecode:${s}`;
  }

  const DEFAULT_SITE = {
    css: "",
    cssEnabled: false,
    js: "",
    jsEnabled: false,
    darkMode: null, // "on" | "off" | null
  };
  const DEFAULT_DARK_THEME = {
    brightness: 100,
    contrast: 100,
    sepia: 0,
    grayscale: 0,
    mode: 1,
  };
  const DEFAULT_GLOBAL = {
    darkMode: { enabled: false, detectDark: true, theme: { ...DEFAULT_DARK_THEME } },
  };

  const KEY = siteKey();
  if (!KEY) return;

  let CURRENT_DARK_ON = null;
  let AUTO_DECISION = null; // null = not decided for this document, else { dark: boolean }
  let AUTO_PENDING = false;
  let USER_JS_RAN = false;

  installDarkReaderFetchBridge();
  load();

  async function load() {
    const [data, local] = await Promise.all([
      chrome.storage.sync.get([siteItemKey(KEY), "global"]),
      chrome.storage.local.get([siteCodeKey(KEY), USERSCRIPT_SITES_KEY]),
    ]);
    const site = {
      ...DEFAULT_SITE,
      ...(data[siteItemKey(KEY)] || {}),
      ...(local[siteCodeKey(KEY)] || {}),
    };
    const global = mergeGlobal(data.global);

    if (site.cssEnabled && site.css) injectCss(site.css);
    else removeCss();

    const viaUserScripts = (local[USERSCRIPT_SITES_KEY] || []).includes(KEY);
    if (site.jsEnabled && site.js && !viaUserScripts) injectJs();

    const theme = themeFor(global);
    const auto = site.darkMode !== "on" && site.darkMode !== "off";
    if (auto && global.darkMode.enabled && global.darkMode.detectDark) autoDarkMode(theme);
    else applyDarkMode(effectiveDark(global, site), theme);
  }

  function mergeGlobal(raw) {
    const g = { ...DEFAULT_GLOBAL, ...(raw || {}) };
    const dm = g.darkMode || {};
    g.darkMode = {
      enabled: !!dm.enabled,
      detectDark: dm.detectDark !== false,
      theme: { ...DEFAULT_DARK_THEME, ...(dm.theme || {}) },
    };
    return g;
  }

  function effectiveDark(global, site) {
    if (site.darkMode === "on") return true;
    if (site.darkMode === "off") return false;
    return !!global.darkMode.enabled;
  }

  function themeFor(global) {
    return { ...DEFAULT_DARK_THEME, ...(global.darkMode.theme || {}) };
  }

  function injectCss(css) {
    let style = document.getElementById(STYLE_ID_USER);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID_USER;
      style.type = "text/css";
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = css;
  }

  function removeCss() {
    const style = document.getElementById(STYLE_ID_USER);
    if (style) style.remove();
  }

  // Once per document: load() re-runs on every settings change.
  function injectJs() {
    if (USER_JS_RAN) return;
    USER_JS_RAN = true;
    chrome.runtime.sendMessage({ type: "run-user-js" }).catch(() => {});
  }

  // ---- Already-dark detection (Auto) ----
  //
  // Darkening a site that is dark already makes it worse, so Auto measures
  // the page first. The catch is timing: the decision is wanted at
  // document_start (no white flash), but a page's colours are only known once
  // its CSS has loaded, and they cannot be read back once Dark Reader is on.
  // So the verdict is cached per site:
  //   - cached "bright" (fresh): darken immediately, exactly like "On".
  //   - cached "dark": leave the page alone, re-measure when it has loaded and
  //     darken after all if the site has turned bright.
  //   - unknown: hold the anti-flash preamble, measure as soon as <body> and
  //     the head's stylesheets exist, confirm at DOMContentLoaded if that
  //     early look was inconclusive, then keep looking for up to 2 s while
  //     the page is still a blank canvas (apps that render late).

  async function autoDarkMode(theme) {
    if (AUTO_DECISION) return applyDarkMode(!AUTO_DECISION.dark, theme);
    // Switched to Auto while Dark Reader is already on: the page's own
    // colours are unreadable now, so keep it on and decide on the next load.
    if (CURRENT_DARK_ON === true) return applyDarkMode(true, theme);
    if (AUTO_PENDING) return;
    AUTO_PENDING = true;

    const cached = ((await chrome.storage.local.get(DETECT_KEY))[DETECT_KEY] || {})[KEY];
    if (cached && !cached.dark && Date.now() - cached.at < BRIGHT_TTL_MS) return decide(false, theme, false);

    const knownDark = !!(cached && cached.dark);
    if (!knownDark) setPreamble(true);
    const early = await whenMeasurable();
    let verdict = measure();
    if (early && !verdict.confident) {
      // Nothing painted a background yet. Show the page as it is rather than
      // dark-on-dark, and look again once the DOM is complete.
      if (!knownDark) setPreamble(false);
      await domReady();
      verdict = measure();
    }
    // Still a blank canvas: typically an app that renders after load. Give
    // it a couple of seconds, looking again every 250 ms.
    for (let i = 0; i < 8 && !verdict.confident; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      verdict = measure();
    }
    decide(verdict.dark, theme, true);
  }

  function decide(dark, theme, remember) {
    AUTO_DECISION = { dark };
    AUTO_PENDING = false;
    if (dark) {
      setPreamble(false);
      CURRENT_DARK_ON = false;
    } else {
      applyDarkMode(true, theme);
    }
    if (remember) rememberVerdict(dark);
  }

  async function rememberVerdict(dark) {
    try {
      const all = (await chrome.storage.local.get(DETECT_KEY))[DETECT_KEY] || {};
      all[KEY] = { dark, at: Date.now() };
      const keys = Object.keys(all);
      if (keys.length > DETECT_MAX_SITES) {
        keys.sort((a, b) => all[a].at - all[b].at);
        for (const k of keys.slice(0, keys.length - DETECT_MAX_SITES)) delete all[k];
      }
      await chrome.storage.local.set({ [DETECT_KEY]: all });
    } catch (_) {
      // cache only
    }
  }

  function domReady() {
    if (document.readyState !== "loading") return Promise.resolve();
    return new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  }

  // Resolves true when measuring early (body present, every stylesheet in
  // <head> loaded) and false when it fell back to DOMContentLoaded.
  function whenMeasurable() {
    const sheetsLoaded = () =>
      [...document.querySelectorAll('head link[rel~="stylesheet"]')].every((l) => l.sheet || l.disabled || (l.media && !matchMedia(l.media).matches));
    return new Promise((resolve) => {
      let done = false;
      const finish = (early) => {
        if (done) return;
        done = true;
        resolve(early);
      };
      if (document.readyState !== "loading") return finish(false);
      document.addEventListener("DOMContentLoaded", () => finish(false), { once: true });
      const tick = () => {
        if (done) return;
        if (document.body && sheetsLoaded()) return finish(true);
        requestAnimationFrame(tick); // paused in background tabs; DOMContentLoaded covers those
      };
      tick();
    });
  }

  let colorCtx = null;
  // [r, g, b, a] for any CSS colour; modern syntaxes (oklch(), color()) come
  // back from getComputedStyle unconverted, a canvas normalises them.
  function parseColor(str) {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(str);
    if (m) {
      const a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return [Number(m[1]), Number(m[2]), Number(m[3]), a];
    }
    try {
      if (!colorCtx) colorCtx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = "#000";
      colorCtx.fillStyle = str;
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    } catch (_) {
      return [255, 255, 255, 0];
    }
  }

  function luminance([r, g, b]) {
    const lin = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  // Looks at what is actually painted behind five points of the viewport.
  // Returns { dark, confident }; not confident = nothing has painted a
  // background yet and the page is still (nearly) empty.
  function measure() {
    const preamble = document.getElementById(STYLE_ID_DARK_PREAMBLE);
    if (preamble) preamble.disabled = true; // synchronous: never painted
    try {
      const meta = document.querySelector('meta[name="color-scheme" i]');
      const declared = meta ? String(meta.content || "").toLowerCase() : "";
      if (/\bdark\b/.test(declared) && !/\blight\b/.test(declared)) return { dark: true, confident: true };

      const root = document.documentElement;
      const scheme = getComputedStyle(root).colorScheme || "";
      const canvasDark = /\bdark\b/.test(scheme) && (!/\blight\b/.test(scheme) || matchMedia("(prefers-color-scheme: dark)").matches);

      const backgroundOf = (el) => {
        const c = parseColor(getComputedStyle(el).backgroundColor);
        return c[3] >= 0.5 ? c : null;
      };
      // The canvas behind everything takes html's background, or else body's
      // (CSS background propagation), whatever size those boxes are.
      const canvasBg = backgroundOf(root) || (document.body && backgroundOf(document.body)) || null;

      const w = window.innerWidth;
      const h = window.innerHeight;
      const points = w && h ? [[0.5, 0.12], [0.12, 0.5], [0.5, 0.5], [0.88, 0.5], [0.5, 0.88]] : [];
      let dark = 0;
      let painted = 0;
      for (const [fx, fy] of points) {
        let bg = null;
        for (const el of document.elementsFromPoint(w * fx, h * fy)) {
          bg = backgroundOf(el);
          if (bg) break;
        }
        bg = bg || canvasBg;
        if (bg) painted += 1;
        if (bg ? luminance(bg) < 0.18 : canvasDark) dark += 1;
      }
      if (!points.length) {
        // Zero-sized viewport (prerender): fall back to body / html.
        return { dark: canvasBg ? luminance(canvasBg) < 0.18 : canvasDark, confident: !!canvasBg };
      }
      // A parsed page full of content that paints no background anywhere is
      // simply using the default canvas; only a near-empty one (an app that
      // has not rendered yet) is worth waiting for.
      const hasContent = document.readyState !== "loading" && !!document.body && document.body.getElementsByTagName("*").length > 60;
      return { dark: dark >= 3, confident: painted >= 3 || hasContent };
    } finally {
      if (preamble) preamble.disabled = false;
    }
  }

  // Anti-flash preamble: paint the document dark immediately so the
  // user doesn't see a white flash before Dark Reader takes over.
  function setPreamble(on) {
    const existing = document.getElementById(STYLE_ID_DARK_PREAMBLE);
    if (!on) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const style = document.createElement("style");
    style.id = STYLE_ID_DARK_PREAMBLE;
    style.textContent = `
      html, body { background-color: #181a1b !important; color-scheme: dark !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function applyDarkMode(on, theme) {
    if (on === CURRENT_DARK_ON) {
      // State unchanged, but theme might have moved. Re-push to SW only if on.
      if (on) sendApply(theme);
      return;
    }
    CURRENT_DARK_ON = on;
    setPreamble(on);
    sendApply(on ? theme : null);
  }

  function sendApply(theme) {
    chrome.runtime
      .sendMessage({
        type: "apply-dark-mode",
        enabled: !!theme,
        theme: theme || null,
      })
      .catch(() => {});
  }

  // Bridges Dark Reader's setFetchMethod (running in MAIN world, subject
  // to page CORS) to the service worker (which has <all_urls> and can
  // read cross-origin CSS). The MAIN-world side of this bridge is
  // installed by service_worker.js right after vendor/darkreader.js
  // loads. Listener is registered unconditionally so it's ready before
  // Dark Reader gets injected later in the page's lifecycle.
  function installDarkReaderFetchBridge() {
    const REQ = "__cb_dr_request__";
    const RES = "__cb_dr_response__";

    window.addEventListener("message", async (e) => {
      if (e.source !== window) return;
      const m = e.data;
      if (!m || typeof m !== "object" || m.kind !== REQ) return;
      try {
        const resp = await chrome.runtime.sendMessage({
          type: "cb-dr-fetch",
          url: m.url,
        });
        if (!resp || !resp.ok) {
          throw new Error((resp && resp.error) || "no response");
        }
        window.postMessage(
          {
            kind: RES,
            id: m.id,
            body: resp.result.body,
            contentType: resp.result.contentType,
          },
          "*"
        );
      } catch (err) {
        window.postMessage(
          { kind: RES, id: m.id, error: String(err.message || err) },
          "*"
        );
      }
    });
  }

  // Live updates. Popup or options changing storage should immediately
  // reapply without a page reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    const touchesUs =
      area === "sync"
        ? changes.global || changes[siteItemKey(KEY)]
        : area === "local" && changes[siteCodeKey(KEY)];
    if (touchesUs) load();
  });

  // Direct messages from the SW (e.g. CSS hot-reload from options page).
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "cb-css-changed":
        if (msg.enabled && msg.css) injectCss(msg.css);
        else removeCss();
        break;
      case "cb-recompute-dark":
        // Forced re-evaluation (e.g. after schema migration or commands).
        load();
        break;
    }
  });
})();
