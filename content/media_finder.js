// Walks the DOM for <video>/<source>/<audio> elements and reports any
// real (non-blob:, non-data:) media URLs to the service worker. A
// MutationObserver keeps the report current as SPAs swap players in/out.
//
// Pairs with the webRequest sniffer in background/service_worker.js: this
// catches what the player advertises in the DOM, the SW catches anything
// that comes through the network. The popup's Media tab dedupes both.

(() => {
  if (window.__cb_media_finder) return;
  window.__cb_media_finder = true;

  const seen = new Set();

  function classifyUrl(url) {
    try {
      const u = new URL(url, location.href);
      const path = u.pathname.toLowerCase();
      if (path.endsWith(".m3u8")) return "hls";
      if (path.endsWith(".mpd")) return "dash";
      if (path.endsWith(".mp4") || path.endsWith(".m4v")) return "mp4";
      if (path.endsWith(".webm")) return "webm";
      if (path.endsWith(".mov")) return "mov";
      if (path.endsWith(".mkv")) return "mkv";
      if (path.endsWith(".ogv") || path.endsWith(".ogg")) return "ogg";
      if (path.endsWith(".mp3")) return "mp3";
      if (path.endsWith(".m4a")) return "m4a";
      if (path.endsWith(".wav")) return "wav";
      return null;
    } catch {
      return null;
    }
  }

  function absUrl(s) {
    try {
      return new URL(s, location.href).href;
    } catch {
      return s;
    }
  }

  function pageTitle() {
    return (document.title || location.hostname || "").trim();
  }

  function reportItem(item) {
    if (!item || !item.url) return;
    if (item.url.startsWith("blob:") || item.url.startsWith("data:")) return;
    if (seen.has(item.url)) return;
    seen.add(item.url);
    chrome.runtime
      .sendMessage({ type: "media-found", item: { ...item, source: "dom" } })
      .catch(() => {});
  }

  function inspectMediaEl(el) {
    const tag = el.tagName;
    const isAudio = tag === "AUDIO";
    const direct = el.currentSrc || el.src || el.getAttribute("src");
    if (direct) {
      const kind = classifyUrl(direct) || (isAudio ? "audio" : "video");
      const item = { url: absUrl(direct), kind, title: pageTitle() };
      if (el.videoWidth) item.width = el.videoWidth;
      if (el.videoHeight) item.height = el.videoHeight;
      if (el.duration && isFinite(el.duration)) item.duration = el.duration;
      reportItem(item);
    }
    if (tag === "VIDEO" || tag === "AUDIO") {
      for (const s of el.querySelectorAll("source")) {
        const ss = s.src || s.getAttribute("src");
        if (!ss) continue;
        const kind = classifyUrl(ss) || (isAudio ? "audio" : "video");
        reportItem({
          url: absUrl(ss),
          kind,
          mime: s.type || "",
          title: pageTitle(),
        });
      }
    }
  }

  function harvest(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.tagName === "VIDEO" || root.tagName === "AUDIO" || root.tagName === "SOURCE") {
      const mediaEl = root.tagName === "SOURCE" ? root.parentElement : root;
      if (mediaEl) inspectMediaEl(mediaEl);
    }
    for (const el of root.querySelectorAll("video, audio")) {
      inspectMediaEl(el);
    }
  }

  function start() {
    harvest(document);

    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "childList") {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1) harvest(n);
          }
        } else if (m.type === "attributes" && m.target && m.target.tagName) {
          const tag = m.target.tagName;
          if (tag === "VIDEO" || tag === "AUDIO" || tag === "SOURCE") {
            const mediaEl = tag === "SOURCE" ? m.target.parentElement : m.target;
            if (mediaEl) inspectMediaEl(mediaEl);
          }
        }
      }
    });
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "currentSrc"],
    });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "cb-media-rescan") {
        seen.clear();
        harvest(document);
        sendResponse({ ok: true });
        return true;
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
