// Runs at document_start on every page (top frame only, isolated world).
// Responsibilities:
//   1. Look up site + global settings from chrome.storage.sync.
//   2. Inject per-site user CSS via a <style> on documentElement.
//   3. Inject per-site user JS via a <script textContent> in the page world.
//   4. Decide whether dark mode should be on, drop an anti-flash preamble,
//      and ask the service worker to load Dark Reader into the page world.
//   5. React to live storage changes (popup / options toggles) without a reload.

(() => {
  if (window.__cb_injected) return;
  window.__cb_injected = true;

  const STYLE_ID_USER = "__cb_user_css__";
  const STYLE_ID_DARK_PREAMBLE = "__cb_dark_preamble__";
  const SCRIPT_ID_USER = "__cb_user_js__";

  function siteKey() {
    let host = location.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host || null;
  }

  function siteItemKey(s) {
    return `site:${s}`;
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
    darkMode: { enabled: false, theme: { ...DEFAULT_DARK_THEME } },
  };

  const KEY = siteKey();
  if (!KEY) return;

  let CURRENT_DARK_ON = null;

  installDarkReaderFetchBridge();
  load();

  async function load() {
    const data = await chrome.storage.sync.get([siteItemKey(KEY), "global"]);
    const site = { ...DEFAULT_SITE, ...(data[siteItemKey(KEY)] || {}) };
    const global = mergeGlobal(data.global);

    if (site.cssEnabled && site.css) injectCss(site.css);
    if (site.jsEnabled && site.js) injectJs(site.js);

    applyDarkMode(effectiveDark(global, site), themeFor(global));
  }

  function mergeGlobal(raw) {
    const g = { ...DEFAULT_GLOBAL, ...(raw || {}) };
    const dm = g.darkMode || {};
    g.darkMode = {
      enabled: !!dm.enabled,
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

  function injectJs(code) {
    if (document.getElementById(SCRIPT_ID_USER)) return;
    const script = document.createElement("script");
    script.id = SCRIPT_ID_USER;
    script.textContent = `try{\n${code}\n}catch(e){console.error("[ComboBreaker user JS]",e);}`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
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
    if (area !== "sync") return;
    const touchesUs =
      changes.global || changes[siteItemKey(KEY)];
    if (touchesUs) load();
  });

  // Direct messages from the SW (e.g. CSS hot-reload from options page).
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "cb-css-changed":
        if (msg.enabled && msg.css) injectCss(msg.css);
        else {
          const s = document.getElementById(STYLE_ID_USER);
          if (s) s.remove();
        }
        break;
      case "cb-recompute-dark":
        // Forced re-evaluation (e.g. after schema migration or commands).
        load();
        break;
    }
  });
})();
