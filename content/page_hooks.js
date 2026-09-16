// Page-world (MAIN) hook for sites whose players use blob: URLs but whose own
// API responses contain the real media URLs. Runs at document_start.
//
// Currently: Twitter / X. The web app fetches timelines and tweet details from
// /i/api/graphql/*; every tweet with video carries
// legacy.extended_entities.media[].video_info.variants, which lists direct
// MP4s at several bitrates plus an HLS playlist. We wrap fetch/XHR, parse the
// JSON, and hand the extracted records to the isolated-world overlay script
// via a CustomEvent on document. Nothing leaves the page.
//
// Records look like:
//   { site: "twitter", mediaId, tweetId, tweetUrl, text, thumb, width,
//     height, durationMs, kind: "video"|"gif", variants: [{url, kind, bitrate, mime}] }

(() => {
  if (window.__cb_page_hooks) return;
  window.__cb_page_hooks = true;

  const EVT_OUT = "cb-media-hook";
  const EVT_REPLAY = "cb-media-hook-replay";
  const store = new Map(); // mediaId -> record

  const host = location.hostname.toLowerCase();
  const isTwitter = /(^|\.)(twitter\.com|x\.com)$/.test(host);
  if (!isTwitter) return;

  const API_RE = /\/i\/api\/(graphql|2|1\.1)\//;

  function emit(records) {
    if (!records.length) return;
    try {
      document.dispatchEvent(new CustomEvent(EVT_OUT, { detail: JSON.stringify(records) }));
    } catch {}
  }

  document.addEventListener(EVT_REPLAY, () => emit([...store.values()]));

  function ingest(json) {
    const found = [];
    walk(json, found, 0);
    const fresh = [];
    for (const r of found) {
      if (!r.variants.every((v) => /^https:\/\//i.test(v.url))) continue;
      const prev = store.get(r.mediaId);
      if (prev && prev.variants.length >= r.variants.length) continue;
      store.set(r.mediaId, r);
      fresh.push(r);
    }
    emit(fresh);
  }

  function walk(node, out, depth) {
    if (!node || typeof node !== "object" || depth > 40) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, out, depth + 1);
      return;
    }
    const ee = node.extended_entities;
    if (ee && Array.isArray(ee.media)) {
      const tweetId = String(node.id_str || node.conversation_id_str || "");
      const text = typeof node.full_text === "string" ? node.full_text : "";
      for (const m of ee.media) {
        const rec = mediaRecord(m, tweetId, text);
        if (rec) out.push(rec);
      }
    }
    for (const k in node) {
      if (k === "extended_entities") continue;
      const v = node[k];
      if (v && typeof v === "object") walk(v, out, depth + 1);
    }
  }

  function mediaRecord(m, tweetId, text) {
    if (!m || !m.video_info || !Array.isArray(m.video_info.variants)) return null;
    const variants = [];
    for (const v of m.video_info.variants) {
      if (!v || !v.url) continue;
      const ct = String(v.content_type || "");
      if (ct === "video/mp4") {
        variants.push({ url: v.url, kind: "mp4", bitrate: v.bitrate || 0, mime: ct, res: resFromUrl(v.url) });
      } else if (ct === "application/x-mpegURL" || /\.m3u8(\?|$)/.test(v.url)) {
        variants.push({ url: v.url, kind: "hls", bitrate: 0, mime: ct });
      }
    }
    if (!variants.length) return null;
    variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const expanded = String(m.expanded_url || "");
    const idFromUrl = (/\/status\/(\d+)/.exec(expanded) || [])[1] || "";
    const tId = tweetId || idFromUrl;
    const thumb = String(m.media_url_https || m.media_url || "");
    const oi = m.original_info || {};
    return {
      site: "twitter",
      mediaId: String(m.id_str || m.media_key || thumb || tId),
      mediaKey: String(m.media_key || ""),
      tweetId: tId,
      tweetUrl: tId ? `https://x.com/i/status/${tId}` : expanded.replace(/\/(video|photo)\/\d+$/, ""),
      text: text.slice(0, 140),
      thumb,
      thumbKey: thumbKey(thumb),
      width: oi.width || (m.sizes && m.sizes.large && m.sizes.large.w) || null,
      height: oi.height || (m.sizes && m.sizes.large && m.sizes.large.h) || null,
      durationMs: m.video_info.duration_millis || null,
      kind: m.type === "animated_gif" ? "gif" : "video",
      variants,
    };
  }

  // pbs.twimg.com/ext_tw_video_thumb/<id>/pu/img/<name>.jpg
  // pbs.twimg.com/amplify_video_thumb/<id>/img/<name>.jpg
  // pbs.twimg.com/tweet_video_thumb/<name>.jpg
  function thumbKey(u) {
    const m =
      /\/(ext_tw_video_thumb|amplify_video_thumb)\/(\d+)\//.exec(u) ||
      /\/(tweet_video_thumb)\/([A-Za-z0-9_-]+)\./.exec(u);
    return m ? `${m[1]}/${m[2]}` : "";
  }

  function resFromUrl(u) {
    const m = /\/(\d{2,4})x(\d{2,4})\//.exec(u);
    return m ? `${m[1]}x${m[2]}` : "";
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input && input.url ? input.url : "";
        if (url && API_RE.test(url)) {
          p.then((res) => {
            try {
              const ct = res.headers.get("content-type") || "";
              if (!/json/i.test(ct)) return;
              res
                .clone()
                .json()
                .then(ingest)
                .catch(() => {});
            } catch {}
          }).catch(() => {});
        }
      } catch {}
      return p;
    };
  }

  // ---- XHR ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try {
        this.__cb_url = typeof url === "string" ? url : String(url);
      } catch {}
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      try {
        const url = this.__cb_url || "";
        if (url && API_RE.test(url)) {
          this.addEventListener("load", () => {
            try {
              let data = null;
              if (this.responseType === "" || this.responseType === "text") {
                data = JSON.parse(this.responseText);
              } else if (this.responseType === "json") {
                data = this.response;
              }
              if (data) ingest(data);
            } catch {}
          });
        }
      } catch {}
      return origSend.apply(this, arguments);
    };
  }
})();
