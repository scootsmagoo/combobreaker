// Runs at document_start on every page (top frame only).
// Responsibilities:
//   1. Look up site settings from chrome.storage.sync (no SW round-trip needed).
//   2. Inject per-site user CSS via a <style> on documentElement.
//   3. Inject per-site user JS via a <script textContent> in the page world.
//   4. Apply dark-mode CSS filter if enabled for this site.
//   5. Listen for live-update messages from the SW (popup toggled darkmode etc).

(() => {
  if (window.__cb_injected) return;
  window.__cb_injected = true;

  const STYLE_ID_USER = "__cb_user_css__";
  const STYLE_ID_DARK = "__cb_dark_mode__";
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
    darkMode: null,
  };
  const DEFAULT_GLOBAL = { defaultDarkMode: false };

  const key = siteKey();
  if (!key) return;

  chrome.storage.sync.get([siteItemKey(key), "global"], (data) => {
    const site = { ...DEFAULT_SITE, ...(data[siteItemKey(key)] || {}) };
    const global = { ...DEFAULT_GLOBAL, ...(data.global || {}) };
    apply(site, global);
  });

  function apply(site, global) {
    if (site.cssEnabled && site.css) injectCss(site.css);
    if (site.jsEnabled && site.js) injectJs(site.js);
    const dark = site.darkMode == null ? global.defaultDarkMode : site.darkMode;
    if (dark) applyDarkMode(true);
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

  function applyDarkMode(on) {
    const existing = document.getElementById(STYLE_ID_DARK);
    if (!on) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const style = document.createElement("style");
    style.id = STYLE_ID_DARK;
    style.textContent = `
      html { background: #181818 !important; }
      html { filter: invert(1) hue-rotate(180deg); }
      img, picture, video, iframe, canvas, svg, [style*="background-image"] {
        filter: invert(1) hue-rotate(180deg);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "cb-dark-mode-changed":
        applyDarkMode(!!msg.enabled);
        break;
      case "cb-css-changed":
        if (msg.enabled && msg.css) injectCss(msg.css);
        else {
          const s = document.getElementById(STYLE_ID_USER);
          if (s) s.remove();
        }
        break;
    }
  });
})();
