// Injected in order: Readability.js, turndown.js, this file, then a tiny `func` in
// the service worker. The `func` stringifies separately; it must not rely on
// lexical `Readability` from earlier files — use globalThis only.
(function initCbReader() {
  "use strict";

  function getReadability() {
    if (typeof globalThis !== "undefined" && typeof globalThis.Readability === "function") {
      return globalThis.Readability;
    }
    if (typeof module !== "undefined" && module && module.exports) {
      return module.exports;
    }
    if (typeof Readability === "function") {
      return Readability;
    }
    return null;
  }

  function getTurndown() {
    if (typeof globalThis !== "undefined" && typeof globalThis.TurndownService === "function") {
      return globalThis.TurndownService;
    }
    if (typeof module !== "undefined" && module && module.exports) {
      var ex = module.exports;
      if (typeof ex === "function") {
        return ex;
      }
      if (ex && ex.default && typeof ex.default === "function") {
        return ex.default;
      }
    }
    if (typeof TurndownService === "function") {
      return TurndownService;
    }
    return null;
  }

  globalThis.__cbRunReader = function () {
    const R = getReadability();
    const TS = getTurndown();
    if (!R) {
      return { ok: false, error: "Readability is not available (injection or globals issue)." };
    }
    if (!TS) {
      return { ok: false, error: "Turndown is not available (injection or globals issue)." };
    }
    if (!document || !document.cloneNode) {
      return { ok: false, error: "No document in this context." };
    }
    var article;
    try {
      article = new R(document.cloneNode(true), { charThreshold: 50 }).parse();
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
    if (!article || !article.content) {
      return { ok: false, error: "No main article could be detected on this page." };
    }
    try {
      const td = new TS();
      const md = td.turndown(article.content);
      const title = article.title || document.title || "";
      const line = title ? "# " + title + "\n\n" : "";
      return {
        ok: true,
        title: title,
        url: (typeof location !== "undefined" && location.href) || "",
        html: article.content,
        markdown: line + md,
        dir: article.dir || "ltr",
        lang:
          article.lang ||
          (document.documentElement && document.documentElement.getAttribute("lang")) ||
          "",
      };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  };
})();
