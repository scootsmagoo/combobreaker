// Injected by the service worker before a tiny `func` calls
// `globalThis.__cbExtractStructuredData()`.
(function initCbSchema() {
  "use strict";

  var MAX_TYPES = 64;

  function collectTypes(node, types) {
    if (types.size >= MAX_TYPES) return;
    if (node == null) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) collectTypes(node[i], types);
      return;
    }
    if (typeof node === "object") {
      if (Object.prototype.hasOwnProperty.call(node, "@type")) {
        var t = node["@type"];
        if (Array.isArray(t)) {
          for (var j = 0; j < t.length; j++) {
            if (types.size < MAX_TYPES) types.add(String(t[j]));
          }
        } else if (t != null) {
          types.add(String(t));
        }
      }
      if (Object.prototype.hasOwnProperty.call(node, "@graph")) {
        collectTypes(node["@graph"], types);
        return;
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        if (types.size >= MAX_TYPES) return;
        var key = keys[k];
        if (key.charAt(0) === "@") continue;
        collectTypes(node[key], types);
      }
    }
  }

  function isJsonLdType(attr) {
    if (!attr) return false;
    var s = String(attr).trim().toLowerCase();
    return s === "application/ld+json" || s === "text/json" || s.indexOf("ld+json") !== -1;
  }

  globalThis.__cbExtractStructuredData = function () {
    var out = {
      ok: true,
      pageUrl: "",
      pageTitle: "",
      jsonld: [],
      microdata: { itemscopeCount: 0, itemtypes: [] },
      rdfa: { elementCount: 0, typofs: [] },
    };
    try {
      if (typeof location !== "undefined" && location.href) out.pageUrl = location.href;
    } catch (_e) {}
    try {
      if (document && document.title) out.pageTitle = document.title;
    } catch (_e2) {}

    var list = document.getElementsByTagName("script");
    var idx = 0;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!isJsonLdType(el.getAttribute("type"))) continue;
      var raw = el.textContent || "";
      if (!String(raw).trim()) continue;
      var entry = {
        index: idx,
        raw: raw,
        parsed: null,
        parseError: null,
        types: [],
      };
      try {
        entry.parsed = JSON.parse(raw);
        var ts = new Set();
        collectTypes(entry.parsed, ts);
        entry.types = Array.from(ts);
      } catch (e) {
        entry.parseError = (e && e.message) || String(e);
      }
      out.jsonld.push(entry);
      idx += 1;
    }

    var scopes;
    try {
      scopes = document.querySelectorAll("[itemscope]");
    } catch (e) {
      scopes = [];
    }
    out.microdata.itemscopeCount = scopes.length;
    var typeSet = new Set();
    for (var s = 0; s < scopes.length; s++) {
      var it = scopes[s].getAttribute("itemtype");
      if (!it) continue;
      var parts = it.split(/\s+/);
      for (var p = 0; p < parts.length; p++) {
        if (parts[p]) typeSet.add(parts[p].trim());
      }
    }
    out.microdata.itemtypes = Array.from(typeSet);

    var rdfaEls;
    try {
      rdfaEls = document.querySelectorAll("[typeof]");
    } catch (e) {
      rdfaEls = [];
    }
    out.rdfa.elementCount = rdfaEls.length;
    var rSet = new Set();
    for (var r = 0; r < rdfaEls.length; r++) {
      var ty = rdfaEls[r].getAttribute("typeof");
      if (!ty) continue;
      var rp = ty.split(/\s+/);
      for (var q = 0; q < rp.length; q++) {
        if (rp[q]) rSet.add(rp[q].trim());
      }
    }
    out.rdfa.typofs = Array.from(rSet);

    return out;
  };
})();
