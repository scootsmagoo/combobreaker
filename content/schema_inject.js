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

  var MAX_HEADINGS = 200;
  var MAX_SAMPLES = 12;

  function clip(v, n) {
    var t = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  }

  // Head tags, heading outline and image/link counts for the viewer's
  // "Meta & SEO" section. DOM only: no link is ever fetched.
  function extractMeta() {
    var meta = {
      title: clip(document.title, 500),
      description: "",
      canonical: "",
      robots: "",
      lang: document.documentElement.getAttribute("lang") || "",
      viewport: "",
      og: [],
      twitter: [],
      hreflang: [],
      headings: [],
      headingCounts: { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
      images: { total: 0, missingAlt: 0, samples: [] },
      links: { total: 0, internal: 0, external: 0, nofollow: 0 },
    };
    var metas = document.getElementsByTagName("meta");
    for (var i = 0; i < metas.length; i++) {
      var m = metas[i];
      var name = (m.getAttribute("name") || "").toLowerCase();
      var prop = (m.getAttribute("property") || "").toLowerCase();
      var content = clip(m.getAttribute("content"), 1000);
      if (name === "description" && !meta.description) meta.description = content;
      else if (name === "robots" && !meta.robots) meta.robots = content;
      else if (name === "viewport" && !meta.viewport) meta.viewport = content;
      if (prop.indexOf("og:") === 0 || prop.indexOf("article:") === 0) meta.og.push({ key: prop, value: content });
      else if (name.indexOf("twitter:") === 0 || prop.indexOf("twitter:") === 0) meta.twitter.push({ key: name || prop, value: content });
    }
    var links = document.getElementsByTagName("link");
    for (var l = 0; l < links.length; l++) {
      var rel = (links[l].getAttribute("rel") || "").toLowerCase();
      if (rel === "canonical" && !meta.canonical) meta.canonical = links[l].href || "";
      else if (rel === "alternate" && links[l].getAttribute("hreflang") && meta.hreflang.length < 50) {
        meta.hreflang.push({ key: links[l].getAttribute("hreflang"), value: links[l].href || "" });
      }
    }
    var hs = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (var h = 0; h < hs.length; h++) {
      var tag = hs[h].tagName.toLowerCase();
      meta.headingCounts[tag] += 1;
      if (meta.headings.length < MAX_HEADINGS) meta.headings.push({ level: Number(tag.charAt(1)), text: clip(hs[h].textContent, 160) });
    }
    var imgs = document.images;
    meta.images.total = imgs.length;
    for (var g = 0; g < imgs.length; g++) {
      // alt="" is a deliberate "decorative" marker; only a missing attribute counts.
      if (imgs[g].hasAttribute("alt")) continue;
      meta.images.missingAlt += 1;
      if (meta.images.samples.length < MAX_SAMPLES) meta.images.samples.push(clip(imgs[g].currentSrc || imgs[g].src, 300));
    }
    var as = document.querySelectorAll("a[href]");
    meta.links.total = as.length;
    for (var a = 0; a < as.length; a++) {
      var host = as[a].hostname;
      if (!host || !/^https?:$/.test(as[a].protocol)) continue;
      if (host === location.hostname) meta.links.internal += 1;
      else meta.links.external += 1;
      if (/\bnofollow\b/i.test(as[a].getAttribute("rel") || "")) meta.links.nofollow += 1;
    }
    return meta;
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

    try {
      out.meta = extractMeta();
    } catch (_e3) {
      out.meta = null;
    }

    return out;
  };
})();
