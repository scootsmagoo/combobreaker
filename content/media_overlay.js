// On-page download badge for videos. Runs at document_start in every frame
// (isolated world). The DOM is never modified except for one shadow-DOM host
// appended to <html>; everything we draw lives inside that shadow root, so
// page CSS and SPA re-renders can't touch it.
//
// How it works:
//   - Track the pointer with a throttled mousemove + document.elementsFromPoint.
//     Site adapters (YouTube, Twitter/X, generic <video>) decide whether an
//     element in that stack is a "target" and how to resolve it to an Item.
//   - Hovering a target shows one floating badge at its top-right corner.
//     Click = download the best source; the caret opens a menu of sources,
//     quality presets (yt-dlp bridge) and copy helpers.
//   - yt-dlp jobs stream progress from the service worker; the badge for that
//     item is pinned with a percentage until it finishes.
//   - The popup's Media tab asks this script for the list of items on the page
//     and can ask it to scroll to / flash one of them.
//
// Item = { id, site, title, page, thumb, width, height, duration,
//          sources: [{ kind: mp4|webm|mov|hls|dash|ytdlp, url, label, res, bitrate }] }

(() => {
  if (window.__cb_media_overlay) return;
  window.__cb_media_overlay = true;
  if (!/^https?:$/.test(location.protocol)) return;

  const HOST = location.hostname.toLowerCase();
  const IS_TOP = window === window.top;
  const IS_TWITTER = /(^|\.)(twitter\.com|x\.com)$/.test(HOST);
  const IS_YOUTUBE = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(HOST);

  const QUALITY_PRESETS = [
    { q: "best", label: "Best available" },
    { q: "1080", label: "1080p" },
    { q: "720", label: "720p" },
    { q: "480", label: "480p" },
    { q: "audio", label: "Audio only (MP3)" },
  ];

  // ---------- settings ----------

  // Chrome Web Store installs carry an update_url; side-loaded ones do not.
  // The store does not allow extensions to offer YouTube downloads, so a store
  // install shows no badge on YouTube unless the user turns badges on for that
  // site themselves (popup → Media, or the per-site setting in options).
  const STORE_INSTALL = !!chrome.runtime.getManifest().update_url;

  let ENABLED = true;
  let SITE_KEY = HOST.startsWith("www.") ? HOST.slice(4) : HOST;

  async function loadSettings() {
    try {
      const data = await chrome.storage.sync.get([`site:${SITE_KEY}`, "global"]);
      const site = data[`site:${SITE_KEY}`] || {};
      const global = data.global || {};
      const g = global.mediaOverlayEnabled !== false;
      const byDefault = IS_YOUTUBE && STORE_INSTALL ? false : g;
      ENABLED = site.mediaOverlay === true ? true : site.mediaOverlay === false ? false : byDefault;
    } catch {
      ENABLED = !(IS_YOUTUBE && STORE_INSTALL);
    }
    if (!ENABLED) hideBadge(true);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.global || changes[`site:${SITE_KEY}`]) loadSettings();
  });

  // ---------- Twitter records (from content/page_hooks.js) ----------

  const twByThumb = new Map(); // thumbKey -> record
  const twByTweet = new Map(); // tweetId -> [record]

  document.addEventListener("cb-media-hook", (e) => {
    let recs = [];
    try {
      recs = JSON.parse(e.detail || "[]");
    } catch {
      return;
    }
    for (const r of recs) {
      // Any page script can fire this event; only accept well-formed records.
      if (!r || !Array.isArray(r.variants) || !r.variants.length) continue;
      if (!r.variants.every((v) => v && /^https:\/\//i.test(v.url))) continue;
      if (r.tweetUrl && !/^https:\/\/(x\.com|twitter\.com)\//i.test(r.tweetUrl)) continue;
      if (r.thumb && !/^https:\/\//i.test(r.thumb)) r.thumb = "";
      if (r.thumbKey) twByThumb.set(r.thumbKey, r);
      if (r.tweetId) {
        const arr = twByTweet.get(r.tweetId) || [];
        const idx = arr.findIndex((x) => x.mediaId === r.mediaId);
        if (idx >= 0) arr[idx] = r;
        else arr.push(r);
        twByTweet.set(r.tweetId, arr);
      }
    }
  });

  // ---------- ids ----------

  const genericIds = new WeakMap();
  let genericCounter = 0;
  function genericId(el) {
    let id = genericIds.get(el);
    if (!id) {
      id = `g:${++genericCounter}`;
      genericIds.set(el, id);
    }
    return id;
  }

  // ---------- adapters ----------

  function classifyUrl(url) {
    try {
      const u = new URL(url, location.href);
      const p = u.pathname.toLowerCase();
      if (p.endsWith(".m3u8")) return "hls";
      if (p.endsWith(".mpd")) return "dash";
      if (p.endsWith(".mp4") || p.endsWith(".m4v")) return "mp4";
      if (p.endsWith(".webm")) return "webm";
      if (p.endsWith(".mov")) return "mov";
      if (p.endsWith(".mkv")) return "mkv";
      if (p.endsWith(".ogv") || p.endsWith(".ogg")) return "ogg";
      if (p.endsWith(".mp3")) return "mp3";
      if (p.endsWith(".m4a")) return "m4a";
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

  function pageUrl() {
    return location.href;
  }

  function pageTitle() {
    return (document.title || HOST).replace(/\s*[-|·]\s*(YouTube|X|Twitter)\s*$/i, "").trim();
  }

  function ytVideoIdFromHref(href) {
    try {
      const u = new URL(href, location.href);
      if (!/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(u.hostname)) return null;
      if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = /^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{6,})/.exec(u.pathname);
      if (m) return m[2];
      return null;
    } catch {
      return null;
    }
  }

  function ytWatchUrl(id) {
    return `https://www.youtube.com/watch?v=${id}`;
  }

  const ADAPTERS = [
    // ---- YouTube ----
    {
      name: "youtube",
      active: () => IS_YOUTUBE,
      // The inline hover preview (ytd-video-preview) drops a second player on
      // top of the thumbnail. It has no stable video id of its own, so it is
      // ignored; the thumbnail anchor underneath it is the real target.
      isPreview(el) {
        return !!el.closest("ytd-video-preview, #video-preview, ytd-moving-thumbnail-renderer");
      },
      match(el, opts) {
        if (el.tagName === "A") {
          const href = el.getAttribute("href") || "";
          if (!/watch\?v=|\/shorts\/|youtu\.be\//.test(href)) return null;
          if (!el.querySelector("img, yt-image, yt-img-shadow")) return null;
          if (this.isPreview(el)) return null;
          const r = el.getBoundingClientRect();
          if (r.width < 90 || r.height < 50) return null;
          return { el, kind: "thumb" };
        }
        if (!(opts && opts.thumbsOnly) && el.classList && el.classList.contains("html5-video-player")) {
          if (this.isPreview(el)) return null;
          return { el, kind: "player" };
        }
        return null;
      },
      matchStack(stack) {
        // Thumbnails win over players so a hover preview can't steal the badge.
        for (const el of stack) {
          if (!el || el.nodeType !== 1) continue;
          const t = this.match(el, { thumbsOnly: true });
          if (t) return t;
        }
        for (const el of stack) {
          if (!el || el.nodeType !== 1) continue;
          const t = this.match(el);
          if (t) return t;
        }
        // Ad overlays, end screens and the shorts UI sit around (not inside)
        // the .html5-video-player, so fall back to the nearest player shell.
        for (const el of stack) {
          if (!el || el.nodeType !== 1 || !el.closest) continue;
          const shell = el.closest("#movie_player, ytd-player, #shorts-player, ytd-reel-video-renderer[is-active]");
          if (!shell || this.isPreview(shell)) continue;
          const p = shell.classList.contains("html5-video-player") ? shell : shell.querySelector(".html5-video-player") || shell;
          return { el: p, kind: "player" };
        }
        return null;
      },
      enumerate() {
        const out = [];
        for (const p of document.querySelectorAll(".html5-video-player")) {
          if (this.isPreview(p)) continue;
          if (p.getBoundingClientRect().width > 0) out.push({ el: p, kind: "player" });
        }
        for (const a of document.querySelectorAll('a[href*="watch?v="], a[href*="/shorts/"]')) {
          const t = this.match(a, { thumbsOnly: true });
          if (t) out.push(t);
        }
        return out;
      },
      quickId(t) {
        const id = t.kind === "thumb" ? ytVideoIdFromHref(t.el.getAttribute("href") || "") : currentYtId();
        return id ? `yt:${id}` : null;
      },
      async resolve(t) {
        let vid, title, thumb;
        if (t.kind === "thumb") {
          vid = ytVideoIdFromHref(t.el.getAttribute("href") || "");
          title = ytTitleNear(t.el);
        } else {
          vid = currentYtId();
          // querySelector with a selector list returns the first match in
          // DOM order, so try the candidates one at a time, best first.
          for (const sel of [
            "ytd-watch-metadata h1 yt-formatted-string",
            "ytd-watch-metadata h1",
            "h1.ytd-watch-metadata",
            "ytd-reel-video-renderer[is-active] h2",
            ".ytp-title-link",
          ]) {
            title = cleanTitle(textOf(document.querySelector(sel)));
            if (title) break;
          }
          if (!title) title = pageTitle();
        }
        if (!vid) return null;
        thumb = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
        return {
          id: `yt:${vid}`,
          site: "youtube",
          title: title || `YouTube ${vid}`,
          page: ytWatchUrl(vid),
          thumb,
          sources: [{ kind: "ytdlp", url: ytWatchUrl(vid), label: "yt-dlp" }],
        };
      },
    },

    // ---- Twitter / X ----
    {
      name: "twitter",
      active: () => IS_TWITTER,
      match(el) {
        if (el.tagName !== "VIDEO") return null;
        return { el, kind: "video" };
      },
      enumerate() {
        return [...document.querySelectorAll("video")].map((el) => ({ el, kind: "video" }));
      },
      quickId(t) {
        const rec = twRecordFor(t.el);
        return rec ? `tw:${rec.mediaId}` : genericId(t.el);
      },
      async resolve(t) {
        const rec = twRecordFor(t.el);
        if (!rec) {
          const g = await resolveGenericVideo(t.el);
          if (g) {
            const tid = tweetIdNear(t.el);
            if (tid) g.page = `https://x.com/i/status/${tid}`;
            g.sources = g.sources.filter((s) => s.kind !== "ytdlp");
            g.sources.push({ kind: "ytdlp", url: g.page, label: "yt-dlp" });
            g.site = "twitter";
          }
          return g;
        }
        const sources = rec.variants.map((v) => ({
          kind: v.kind,
          url: v.url,
          label: v.kind === "hls" ? "HLS" : "MP4",
          res: v.res || "",
          bitrate: v.bitrate || 0,
        }));
        sources.push({ kind: "ytdlp", url: rec.tweetUrl, label: "yt-dlp" });
        return {
          id: `tw:${rec.mediaId}`,
          site: "twitter",
          title: rec.text || `Tweet ${rec.tweetId}`,
          page: rec.tweetUrl,
          thumb: rec.thumb || t.el.poster || "",
          width: rec.width,
          height: rec.height,
          duration: rec.durationMs ? rec.durationMs / 1000 : null,
          gif: rec.kind === "gif",
          sources,
        };
      },
    },

    // ---- Generic <video> ----
    {
      name: "generic",
      // Site adapters own their sites completely; on YouTube a generic match
      // would only ever be the blob-backed player or a hover preview.
      active: () => !IS_YOUTUBE && !IS_TWITTER,
      match(el) {
        if (el.tagName !== "VIDEO") return null;
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 45) return null;
        return { el, kind: "video" };
      },
      enumerate() {
        return [...document.querySelectorAll("video")]
          .filter((v) => v.getBoundingClientRect().width > 0)
          .map((el) => ({ el, kind: "video" }));
      },
      quickId(t) {
        return genericId(t.el);
      },
      async resolve(t) {
        return resolveGenericVideo(t.el);
      },
    },
  ];

  function currentYtId() {
    return ytVideoIdFromHref(location.href);
  }

  function rectContains(r, x, y) {
    return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function textOf(el) {
    return el ? (el.textContent || "").trim() : "";
  }

  function cleanTitle(s) {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    if (!t || t.length < 2 || /^(true|false|null|undefined)$/i.test(t)) return "";
    return t;
  }

  function ytTitleNear(a) {
    // 1. The renderer around the thumbnail usually has a dedicated title node.
    const TITLE_SEL = [
      "#video-title",
      "a#video-title-link",
      ".yt-lockup-metadata-view-model-wiz__title",
      ".yt-lockup-metadata-view-model__title",
      "h3 a[title]",
      "h3",
    ].join(", ");
    let n = a;
    for (let i = 0; i < 7 && n; i++) {
      n = n.parentElement;
      if (!n || n === document.body) break;
      const tt = n.querySelector(TITLE_SEL);
      if (tt) {
        const s = cleanTitle(tt.getAttribute("title")) || cleanTitle(tt.textContent);
        if (s) return s;
      }
    }
    // 2. Thumbnail image alt text.
    const img = a.querySelector("img[alt]");
    const alt = cleanTitle(img && img.alt);
    if (alt && alt.length > 3) return alt;
    // 3. The anchor's own label ("<title> by <channel> 1,234 views ...").
    const label = cleanTitle(a.getAttribute("title") || a.getAttribute("aria-label"));
    if (label) return label.split(/ by /)[0].replace(/\s+\d[\d,.]* (views|watching).*$/i, "").trim();
    return "";
  }

  function tweetIdNear(el) {
    const art = el.closest("article");
    const scope = art || document;
    const a = scope.querySelector('a[href*="/status/"]');
    const m = a ? /\/status\/(\d+)/.exec(a.getAttribute("href") || "") : /\/status\/(\d+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function twThumbKey(u) {
    const m =
      /\/(ext_tw_video_thumb|amplify_video_thumb)\/(\d+)\//.exec(u || "") ||
      /\/(tweet_video_thumb)\/([A-Za-z0-9_-]+)\./.exec(u || "");
    return m ? `${m[1]}/${m[2]}` : "";
  }

  function twRecordFor(video) {
    const poster = video.poster || video.getAttribute("poster") || "";
    const k = twThumbKey(poster);
    if (k && twByThumb.has(k)) return twByThumb.get(k);
    // Fall back to the tweet's media list, indexed by video order in the article.
    const tid = tweetIdNear(video);
    if (!tid) return null;
    const recs = twByTweet.get(tid);
    if (!recs || !recs.length) return null;
    const art = video.closest("article");
    if (art) {
      const vids = [...art.querySelectorAll("video")];
      const idx = vids.indexOf(video);
      if (idx >= 0 && recs[idx]) return recs[idx];
    }
    return recs[0];
  }

  async function resolveGenericVideo(el) {
    const sources = [];
    const seen = new Set();
    const push = (u, extra) => {
      if (!u) return;
      const abs = absUrl(u);
      if (abs.startsWith("blob:") || abs.startsWith("data:") || seen.has(abs)) return;
      seen.add(abs);
      const kind = classifyUrl(abs) || (extra && extra.kind) || "video";
      sources.push({ kind, url: abs, label: kind.toUpperCase(), ...(extra || {}) });
    };
    push(el.currentSrc || el.src || el.getAttribute("src"));
    for (const s of el.querySelectorAll("source")) {
      const mime = s.type || "";
      const kind = mime.includes("mp4") ? "mp4" : mime.includes("webm") ? "webm" : null;
      push(s.src || s.getAttribute("src"), kind ? { kind } : null);
    }
    if (!sources.length) {
      // blob: / MSE player. Whatever manifests the network sniffer saw for
      // this tab are the best guess; if there's only one video, it's certain.
      try {
        const list = await sendToSw({ type: "media-list-mine" });
        for (const it of list || []) {
          if (it.kind === "hls" || it.kind === "dash") {
            push(it.url, { kind: it.kind, label: it.kind.toUpperCase() });
          }
        }
      } catch {}
    }
    const page = IS_TOP ? pageUrl() : (document.referrer || pageUrl());
    sources.push({ kind: "ytdlp", url: page, label: "yt-dlp" });
    const id = genericId(el);
    return {
      id,
      site: "generic",
      title: pageTitle(),
      page,
      thumb: el.poster || "",
      width: el.videoWidth || null,
      height: el.videoHeight || null,
      duration: el.duration && isFinite(el.duration) ? el.duration : null,
      sources,
    };
  }

  function primarySource(item) {
    const order = ["mp4", "webm", "mov", "mkv", "ogg", "hls", "dash", "mp3", "m4a", "video", "ytdlp"];
    let best = null;
    let bestRank = 99;
    for (const s of item.sources) {
      const r = order.indexOf(s.kind);
      const rank = r < 0 ? 50 : r;
      if (rank < bestRank) {
        best = s;
        bestRank = rank;
      }
    }
    return best;
  }

  // ---------- target lookup ----------

  function targetFromStack(stack, x, y) {
    for (const ad of ADAPTERS) {
      if (!ad.active()) continue;
      if (ad.matchStack) {
        const t = ad.matchStack(stack.filter((e) => e !== shadowHost));
        if (t) return { ...t, adapter: ad };
        continue;
      }
      for (const el of stack) {
        if (!el || el === shadowHost) continue;
        const t = ad.match(el);
        if (t) return { ...t, adapter: ad };
      }
      // Players often put a pointer-events:none <video> under click-catching
      // overlays, so it never shows up in elementsFromPoint. Look for a
      // descendant video that contains the pointer in the few deepest
      // (smallest) containers of the stack.
      if (ad.name === "twitter" || ad.name === "generic") {
        const v = videoUnderPoint(stack, x, y);
        if (v) {
          const t = ad.match(v);
          if (t) return { ...t, adapter: ad };
        }
      }
    }
    return null;
  }

  function videoUnderPoint(stack, x, y) {
    const maxArea = window.innerWidth * window.innerHeight * 1.5;
    let checked = 0;
    for (const el of stack) {
      if (!el || el === shadowHost || el.nodeType !== 1) continue;
      if (el.tagName === "HTML" || el.tagName === "BODY") break;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > maxArea) break;
      if (++checked > 8) break;
      let vids;
      try {
        vids = el.querySelectorAll("video");
      } catch {
        continue;
      }
      for (const v of vids) {
        const vr = v.getBoundingClientRect();
        if (vr.width >= 80 && vr.height >= 45 && x >= vr.left && x <= vr.right && y >= vr.top && y <= vr.bottom) {
          return v;
        }
      }
      if (vids.length) return null; // container had videos but none under the pointer
    }
    return null;
  }

  function enumerateTargets() {
    const out = [];
    const seen = new Set();
    for (const ad of ADAPTERS) {
      if (!ad.active()) continue;
      for (const t of ad.enumerate()) {
        const id = ad.quickId(t);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({ ...t, adapter: ad, id });
      }
      if (ad.name !== "generic") break; // site adapter owns its site
    }
    return out;
  }

  // ---------- UI ----------

  let shadowHost = null;
  let root = null;
  let badgeEl = null;
  let menuEl = null;
  let toastsEl = null;
  let pinsEl = null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;
      font: 12px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e2e8f0; }
    .badge { position: fixed; display: none; align-items: stretch; pointer-events: auto;
      background: rgba(15, 23, 42, .94); border: 1px solid rgba(148, 163, 184, .35);
      border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.45); overflow: hidden;
      backdrop-filter: blur(6px); transition: opacity .12s ease; opacity: 0; }
    .badge.show { display: flex; opacity: 1; }
    .badge button { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px;
      padding: 6px 9px; color: #e2e8f0; font: inherit; font-weight: 600; white-space: nowrap; }
    .badge button:hover { background: rgba(56, 189, 248, .18); color: #7dd3fc; }
    .badge button.dl svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2.2;
      stroke-linecap: round; stroke-linejoin: round; }
    .badge button.more { padding: 6px 7px; border-left: 1px solid rgba(148,163,184,.25); font-size: 10px; }
    .badge .lbl { font-size: 11px; letter-spacing: .3px; }
    .badge.busy button.dl { color: #7dd3fc; }
    .badge .kbd { font-size: 10px; opacity: .7; margin-left: 2px; }
    .menu { position: fixed; display: none; pointer-events: auto; min-width: 240px; max-width: 320px;
      background: rgba(15, 23, 42, .97); border: 1px solid rgba(148, 163, 184, .35); border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,.5); padding: 6px; }
    .menu.show { display: block; }
    .menu .hd { padding: 6px 8px 8px; border-bottom: 1px solid rgba(148,163,184,.2); margin-bottom: 4px; }
    .menu .hd .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .menu .hd .m { color: #94a3b8; font-size: 11px; margin-top: 2px; }
    .menu .sec { color: #94a3b8; font-size: 10px; text-transform: uppercase; letter-spacing: .6px; padding: 6px 8px 2px; }
    .menu .row { all: unset; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 10px;
      width: 100%; padding: 6px 8px; border-radius: 6px; font: inherit; color: #e2e8f0; }
    .menu .row:hover { background: rgba(56, 189, 248, .16); color: #7dd3fc; }
    .menu .row .sub { color: #94a3b8; font-size: 11px; }
    .menu .row:hover .sub { color: #7dd3fc; opacity: .8; }
    .menu .row.muted { color: #94a3b8; }
    .menu .sep { height: 1px; background: rgba(148,163,184,.2); margin: 4px 2px; }
    .menu .note { color: #fbbf24; font-size: 11px; padding: 4px 8px 6px; }
    .toasts { position: fixed; right: 14px; bottom: 14px; display: flex; flex-direction: column; gap: 6px; }
    .toast { pointer-events: auto; background: rgba(15, 23, 42, .96); border: 1px solid rgba(148,163,184,.35);
      border-left: 3px solid #38bdf8; border-radius: 8px; padding: 8px 10px; max-width: 340px;
      box-shadow: 0 6px 20px rgba(0,0,0,.45); animation: cbin .15s ease; }
    .toast.err { border-left-color: #f87171; }
    .toast.ok { border-left-color: #4ade80; }
    .toast .tt { font-weight: 600; }
    .toast .tm { color: #94a3b8; font-size: 11px; margin-top: 2px; word-break: break-word; }
    .toast a { color: #7dd3fc; cursor: pointer; text-decoration: underline; }
    @keyframes cbin { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    .pin { position: fixed; pointer-events: auto; display: flex; align-items: center; gap: 6px;
      background: rgba(15, 23, 42, .94); border: 1px solid rgba(56,189,248,.5); border-radius: 8px;
      padding: 5px 8px; font-weight: 600; box-shadow: 0 6px 20px rgba(0,0,0,.45); }
    .pin .bar { width: 64px; height: 5px; background: rgba(148,163,184,.25); border-radius: 3px; overflow: hidden; }
    .pin .bar i { display: block; height: 100%; width: 0; background: #38bdf8; transition: width .2s; }
    .pin.done { border-color: rgba(74,222,128,.6); }
    .pin.err { border-color: rgba(248,113,113,.6); }
    .pin .x { all: unset; cursor: pointer; color: #94a3b8; padding: 0 2px; }
    .pin .x:hover { color: #f87171; }
    .prompt { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); pointer-events: auto;
      width: min(420px, calc(100vw - 32px)); background: rgba(15, 23, 42, .98); border: 1px solid rgba(148,163,184,.4);
      border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,.55); padding: 18px 18px 14px; font-size: 13px; animation: cbin .15s ease; }
    .prompt .pt { font-size: 15px; font-weight: 700; margin-bottom: 6px; }
    .prompt .pm { color: #cbd5e1; line-height: 1.45; }
    .prompt .pm b { color: #e2e8f0; }
    .prompt .pb { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
    .prompt button { all: unset; cursor: pointer; padding: 7px 12px; border-radius: 7px; font: inherit; font-weight: 600; }
    .prompt button.go { background: #38bdf8; color: #0b1220; }
    .prompt button.go:hover { background: #7dd3fc; }
    .prompt button.no { color: #94a3b8; }
    .prompt button.no:hover { color: #e2e8f0; }
    .scrim { position: fixed; inset: 0; pointer-events: auto; background: rgba(0,0,0,.25); }
    .flash { position: fixed; pointer-events: none; border: 3px solid #38bdf8; border-radius: 8px;
      box-shadow: 0 0 0 4px rgba(56,189,248,.35); animation: cbflash 1.6s ease forwards; }
    @keyframes cbflash { 0% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }
  `;

  const DL_SVG =
    '<svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/></svg>';

  function ensureUi() {
    if (shadowHost && shadowHost.isConnected) return;
    if (!document.documentElement) return;
    shadowHost = document.createElement("cb-media-overlay");
    shadowHost.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    root = shadowHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);
    const layer = document.createElement("div");
    layer.className = "layer";
    layer.innerHTML = `
      <div class="badge" part="badge">
        <button class="dl" type="button" title="Download">${DL_SVG}<span class="lbl">…</span></button>
        <button class="more" type="button" title="More options">▼</button>
      </div>
      <div class="menu"></div>
      <div class="pins"></div>
      <div class="toasts"></div>`;
    root.appendChild(layer);
    badgeEl = layer.querySelector(".badge");
    menuEl = layer.querySelector(".menu");
    pinsEl = layer.querySelector(".pins");
    toastsEl = layer.querySelector(".toasts");
    document.documentElement.appendChild(shadowHost);

    badgeEl.addEventListener("mouseenter", () => cancelHide());
    badgeEl.addEventListener("mouseleave", () => scheduleHide());
    badgeEl.querySelector(".dl").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!CURRENT) return;
      quickDownload(CURRENT);
    });
    badgeEl.querySelector(".more").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!CURRENT) return;
      toggleMenu(CURRENT);
    });
    menuEl.addEventListener("mouseenter", () => cancelHide());
    menuEl.addEventListener("mouseleave", () => scheduleHide(400));
  }

  // ---------- hover state ----------

  let CURRENT = null; // { el, kind, adapter, item?, resolving? }
  let hideTimer = null;
  let menuOpen = false;
  let lastPoint = { x: -1, y: -1 };
  let moveRaf = 0;

  function onMove(e) {
    if (!ENABLED) return;
    lastPoint = { x: e.clientX, y: e.clientY };
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      probe(lastPoint.x, lastPoint.y);
    });
  }

  function probe(x, y) {
    if (menuOpen) return;
    let stack;
    try {
      stack = document.elementsFromPoint(x, y);
    } catch {
      return;
    }
    if (stack.includes(shadowHost)) {
      cancelHide();
      return;
    }
    const t = targetFromStack(stack, x, y);
    if (!t) {
      // Nothing hit-testable under the pointer, but if it is still inside the
      // current target's box, keep the badge. YouTube hides the thumbnail
      // anchor while its inline preview plays, which would otherwise make the
      // badge blink out a second after it appeared.
      if (CURRENT && CURRENT.el.isConnected && rectContains(CURRENT.el.getBoundingClientRect(), x, y)) {
        cancelHide();
        positionBadge();
        return;
      }
      scheduleHide();
      return;
    }
    cancelHide();
    if (CURRENT && CURRENT.el === t.el) {
      positionBadge();
      return;
    }
    showFor(t);
  }

  async function showFor(t) {
    ensureUi();
    if (!badgeEl) return;
    CURRENT = t;
    badgeEl.classList.remove("busy");
    setBadgeLabel("…");
    badgeEl.classList.add("show");
    positionBadge();
    const item = await t.adapter.resolve(t);
    if (CURRENT !== t) return;
    if (!item) {
      hideBadge(true);
      return;
    }
    t.item = item;
    const job = jobForItem(item.id);
    if (job && (job.status === "downloading" || job.status === "processing" || job.status === "queued")) {
      badgeEl.classList.add("busy");
      setBadgeLabel(job.percent != null ? `${Math.round(job.percent)}%` : "…");
    } else {
      const p = primarySource(item);
      setBadgeLabel(p ? p.label : "?");
    }
    positionBadge();
  }

  function setBadgeLabel(s) {
    if (badgeEl) badgeEl.querySelector(".lbl").textContent = s;
  }

  function positionBadge() {
    if (!CURRENT || !badgeEl) return;
    const el = CURRENT.el;
    if (!el.isConnected) return hideBadge(true);
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return hideBadge(true);
    const bw = badgeEl.offsetWidth || 90;
    const bh = badgeEl.offsetHeight || 28;
    const pad = 8;
    let left = r.right - bw - pad;
    let top = r.top + pad;
    // If the top edge is off-screen (tall players), pin to the viewport top.
    if (top < 4) top = Math.min(r.bottom - bh - pad, 4);
    left = Math.max(4, Math.min(left, window.innerWidth - bw - 4));
    top = Math.max(4, Math.min(top, window.innerHeight - bh - 4));
    badgeEl.style.left = `${left}px`;
    badgeEl.style.top = `${top}px`;
    if (menuOpen) positionMenu();
  }

  function scheduleHide(ms = 220) {
    if (hideTimer) return;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (menuOpen) return;
      hideBadge();
    }, ms);
  }

  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function hideBadge(force) {
    if (menuOpen && !force) return;
    if (badgeEl) badgeEl.classList.remove("show");
    if (force) closeMenu();
    CURRENT = null;
  }

  // ---------- menu ----------

  function toggleMenu(t) {
    if (menuOpen) return closeMenu();
    openMenu(t);
  }

  function closeMenu() {
    menuOpen = false;
    if (menuEl) {
      menuEl.classList.remove("show");
      menuEl.innerHTML = "";
    }
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("keydown", onKey, true);
  }

  function onDocDown(e) {
    if (e.composedPath && e.composedPath().includes(shadowHost)) return;
    closeMenu();
    scheduleHide(50);
  }

  function onKey(e) {
    if (e.key === "Escape") {
      closeMenu();
      hideBadge(true);
    }
  }

  let menuSeq = 0;

  async function openMenu(t) {
    if (!t.item) return;
    const item = t.item;
    const seq = ++menuSeq;
    menuOpen = true;
    cancelHide();
    menuEl.innerHTML = "";
    // Click-away / Escape work from the first frame, even while the bridge
    // status is still being fetched below.
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    const hd = document.createElement("div");
    hd.className = "hd";
    const meta = [];
    if (item.width && item.height) meta.push(`${item.width}×${item.height}`);
    if (item.duration) meta.push(fmtDur(item.duration));
    if (item.gif) meta.push("GIF");
    hd.innerHTML = `<div class="t"></div><div class="m"></div>`;
    hd.querySelector(".t").textContent = item.title || item.page;
    hd.querySelector(".t").title = item.title || "";
    hd.querySelector(".m").textContent = meta.join(" · ") || hostOf(item.page);
    menuEl.appendChild(hd);

    const direct = item.sources.filter((s) => !["ytdlp", "hls", "dash"].includes(s.kind));
    const manifests = item.sources.filter((s) => s.kind === "hls" || s.kind === "dash");
    const ytd = item.sources.find((s) => s.kind === "ytdlp");

    if (direct.length) {
      addSec("Direct download");
      for (const s of direct) {
        const sub = [s.res, s.bitrate ? `${(s.bitrate / 1e6).toFixed(1)} Mbps` : ""].filter(Boolean).join(" · ");
        addRow(s.label, sub || hostOf(s.url), () => doDownload(t, s, "best"));
      }
    }

    const bridge = await bridgeStatus();
    // Menu was closed (Escape, click-away, download, settings change) or a
    // newer one opened while we waited: don't resurrect it.
    if (seq !== menuSeq || !menuOpen || CURRENT !== t) return;
    if (manifests.length) {
      addSec("Stream");
      for (const s of manifests) {
        const sub = bridge.available ? "via the Helper" : s.kind === "hls" ? "HLS downloader" : "needs the Helper";
        addRow(`${s.label} · ${hostOf(s.url)}`, sub, () => doDownload(t, s, "best"));
      }
    }

    if (ytd) {
      addSec(bridge.available ? "Download" : "YouTube");
      if (bridge.available) {
        for (const p of QUALITY_PRESETS) {
          if (p.q === "audio" && !bridge.ffmpeg) continue;
          addRow(p.label, "", () => doDownload(t, ytd, p.q));
        }
        if (!bridge.ffmpeg) {
          const n = document.createElement("div");
          n.className = "note";
          n.textContent = "ffmpeg not found: best quality may be limited to single-file formats.";
          menuEl.appendChild(n);
        }
      } else {
        addRow("Set up one-click downloads…", "free Helper · about a minute", () => {
          closeMenu();
          showHelperPrompt({ installed: false });
        });
      }
    }

    sep();
    const copyUrl = primaryCopyable(item);
    if (copyUrl) addRow("Copy media URL", hostOf(copyUrl), () => {
      copyText(copyUrl);
      toast("ok", "Copied", copyUrl);
      closeMenu();
    });
    addRow("Copy page URL", "", () => {
      copyText(item.page);
      toast("ok", "Copied", item.page);
      closeMenu();
    });
    // Inside an iframe the "site" would be the embed's host (e.g. youtube.com
    // for an embedded player), which is not what the popup toggle shows, so
    // only offer it from the top frame.
    if (IS_TOP) {
      sep();
      addRow("Hide badges on this site", "", async () => {
        try {
          await sendToSw({ type: "set-site", siteKey: SITE_KEY, patch: { mediaOverlay: false } });
          toast("ok", "Badges hidden", `Re-enable in ComboBreaker › Media for ${SITE_KEY}.`);
        } catch (e) {
          toast("err", "Couldn't save", String(e.message || e));
        }
        closeMenu();
        hideBadge(true);
      }, "muted");
    }

    menuEl.classList.add("show");
    positionMenu();

    function addSec(label) {
      const d = document.createElement("div");
      d.className = "sec";
      d.textContent = label;
      menuEl.appendChild(d);
    }
    function addRow(label, sub, fn, cls) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `row${cls ? " " + cls : ""}`;
      const l = document.createElement("span");
      l.textContent = label;
      b.appendChild(l);
      if (sub) {
        const s = document.createElement("span");
        s.className = "sub";
        s.textContent = sub;
        b.appendChild(s);
      }
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
      menuEl.appendChild(b);
    }
    function sep() {
      const d = document.createElement("div");
      d.className = "sep";
      menuEl.appendChild(d);
    }
  }

  function positionMenu() {
    if (!menuEl || !badgeEl) return;
    const br = badgeEl.getBoundingClientRect();
    const mw = menuEl.offsetWidth || 260;
    const mh = menuEl.offsetHeight || 200;
    let left = br.right - mw;
    let top = br.bottom + 6;
    if (top + mh > window.innerHeight - 6) top = Math.max(6, br.top - mh - 6);
    left = Math.max(6, Math.min(left, window.innerWidth - mw - 6));
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
  }

  function primaryCopyable(item) {
    const p = item.sources.find((s) => s.kind !== "ytdlp");
    return p ? p.url : null;
  }

  // ---------- downloads ----------

  let bridgeCache = null;
  let bridgeCacheAt = 0;
  async function bridgeStatus() {
    if (bridgeCache && Date.now() - bridgeCacheAt < 15000) return bridgeCache;
    try {
      bridgeCache = (await sendToSw({ type: "ytdlp-status" })) || { available: false };
    } catch {
      bridgeCache = { available: false };
    }
    bridgeCacheAt = Date.now();
    return bridgeCache;
  }

  async function quickDownload(t) {
    if (!t.item) {
      toast("err", "Still resolving", "Try again in a moment.");
      return;
    }
    const job = jobForItem(t.item.id);
    if (job && (job.status === "downloading" || job.status === "processing" || job.status === "queued")) {
      toggleMenu(t);
      return;
    }
    const p = primarySource(t.item);
    if (!p) return toast("err", "No source", "Nothing downloadable was found for this video.");
    // No preset: the service worker applies the default quality from options.
    await doDownload(t, p, null);
  }

  async function doDownload(t, source, quality) {
    closeMenu();
    const item = t.item;
    try {
      const res = await sendToSw({
        type: "overlay-download",
        item: { id: item.id, title: item.title, page: item.page, thumb: item.thumb, site: item.site },
        source: { kind: source.kind, url: source.url, res: source.res || "" },
        quality: quality || null,
        referer: location.href,
      });
      if (!res) throw new Error("no response");
      if (res.mode === "direct") {
        toast("ok", "Download started", res.filename || source.url);
      } else if (res.mode === "ytdlp") {
        toast("ok", "Download started", item.title || source.url);
        upsertJob({ id: res.jobId, itemId: item.id, status: "queued", percent: 0, title: item.title });
        pinFor(t, res.jobId);
      } else if (res.mode === "hls-page") {
        toast("ok", "HLS downloader opened", "Pick a quality in the new tab.");
      } else if (res.mode === "needs-helper") {
        hideBadge(true);
        showHelperPrompt(res);
        return;
      } else if (res.mode === "error") {
        throw new Error(res.message || "download failed");
      }
    } catch (e) {
      toast("err", "Download failed", String(e.message || e));
    }
    hideBadge(true);
  }

  // One-time setup prompt for sites that need the Helper (YouTube, DASH).
  let promptEl = null;
  function closePrompt() {
    if (promptEl) promptEl.remove();
    promptEl = null;
    document.removeEventListener("keydown", onPromptKey, true);
  }
  function onPromptKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePrompt();
    }
  }
  function showHelperPrompt(res) {
    ensureUi();
    if (!root) return;
    closePrompt();
    bridgeCache = null; // re-check as soon as the user comes back
    const broken = !!(res && res.installed);
    const wrap = document.createElement("div");
    wrap.className = "scrim";
    const card = document.createElement("div");
    card.className = "prompt";
    card.innerHTML = `<div class="pt"></div><div class="pm"></div>
      <div class="pb"><button type="button" class="no">Not now</button><button type="button" class="go"></button></div>`;
    card.querySelector(".pt").textContent = broken ? "The Helper needs a quick repair" : "One-time setup for YouTube downloads";
    const pm = card.querySelector(".pm");
    if (broken) {
      pm.textContent = `${(res && res.reason) || "The Helper did not answer."} Running the setup again fixes it in about a minute.`;
    } else {
      pm.innerHTML = `Downloading from this site needs the free <b>ComboBreaker Helper</b>, a small program that runs
        yt-dlp on your computer. Nothing is sent anywhere except to the video site itself. Setup takes about a minute,
        and after that every download is one click.`;
    }
    card.querySelector(".go").textContent = broken ? "Repair the Helper" : "Set up now";
    card.querySelector(".go").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendToSw({ type: "open-helper-setup" }).catch(() => {});
      closePrompt();
    });
    card.querySelector(".no").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closePrompt();
    });
    wrap.addEventListener("mousedown", (e) => {
      if (e.target === wrap) closePrompt();
    });
    wrap.appendChild(card);
    root.querySelector(".layer").appendChild(wrap);
    promptEl = wrap;
    document.addEventListener("keydown", onPromptKey, true);
  }

  function copyText(s) {
    try {
      navigator.clipboard.writeText(s).catch(() => fallbackCopy(s));
    } catch {
      fallbackCopy(s);
    }
  }

  function fallbackCopy(s) {
    try {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.style.cssText = "position:fixed;left:-9999px;top:0;";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch {}
  }

  // ---------- yt-dlp jobs + pinned badges ----------

  const jobs = new Map(); // jobId -> job
  const pins = new Map(); // jobId -> { el (target), node }
  let pinRaf = 0;

  function jobForItem(itemId) {
    let latest = null;
    for (const j of jobs.values()) {
      if (j.itemId === itemId && (!latest || (j.updated || 0) > (latest.updated || 0))) latest = j;
    }
    return latest;
  }

  function upsertJob(job) {
    if (!job || !job.id) return;
    const prev = jobs.get(job.id) || {};
    jobs.set(job.id, { ...prev, ...job, updated: Date.now() });
    renderPin(job.id);
    if (CURRENT && CURRENT.item && CURRENT.item.id === job.itemId) {
      const j = jobs.get(job.id);
      if (j.status === "downloading" || j.status === "processing" || j.status === "queued") {
        badgeEl.classList.add("busy");
        setBadgeLabel(j.status === "processing" ? "merging" : j.percent != null ? `${Math.round(j.percent)}%` : "…");
      } else {
        badgeEl.classList.remove("busy");
        const p = primarySource(CURRENT.item);
        setBadgeLabel(p ? p.label : "?");
      }
    }
  }

  function pinFor(t, jobId) {
    ensureUi();
    if (pins.has(jobId)) return;
    const node = document.createElement("div");
    node.className = "pin";
    node.innerHTML = `<span class="pct">0%</span><span class="bar"><i></i></span><button class="x" type="button" title="Cancel">✕</button>`;
    node.querySelector(".x").addEventListener("click", async (e) => {
      e.stopPropagation();
      const j = jobs.get(jobId);
      if (j && (j.status === "downloading" || j.status === "processing" || j.status === "queued")) {
        try {
          await sendToSw({ type: "ytdlp-cancel", jobId });
        } catch {}
      }
      removePin(jobId);
    });
    pinsEl.appendChild(node);
    pins.set(jobId, { el: t.el, node, itemId: t.item ? t.item.id : null });
    renderPin(jobId);
    schedulePinLayout();
  }

  function renderPin(jobId) {
    const pin = pins.get(jobId);
    const job = jobs.get(jobId);
    if (!pin || !job) return;
    const pct = pin.node.querySelector(".pct");
    const bar = pin.node.querySelector(".bar i");
    pin.node.classList.remove("done", "err");
    if (job.status === "done") {
      pin.node.classList.add("done");
      pct.textContent = "Saved ✓";
      bar.style.width = "100%";
      setTimeout(() => removePin(jobId), 5000);
    } else if (job.status === "error") {
      pin.node.classList.add("err");
      pct.textContent = "Failed";
      setTimeout(() => removePin(jobId), 8000);
    } else if (job.status === "cancelled") {
      removePin(jobId);
    } else if (job.status === "processing") {
      pct.textContent = "Merging…";
      bar.style.width = "100%";
    } else {
      pct.textContent = job.percent != null ? `${Math.round(job.percent)}%` : "…";
      bar.style.width = `${job.percent || 0}%`;
    }
    layoutPins();
  }

  function removePin(jobId) {
    const pin = pins.get(jobId);
    if (!pin) return;
    pin.node.remove();
    pins.delete(jobId);
  }

  function schedulePinLayout() {
    if (pinRaf || !pins.size) return;
    pinRaf = requestAnimationFrame(() => {
      pinRaf = 0;
      layoutPins();
    });
  }

  function layoutPins() {
    for (const [jobId, pin] of pins) {
      const el = pin.el;
      if (!el || !el.isConnected) {
        // Element re-rendered away (SPA). Park the pin bottom-left.
        pin.node.style.left = "14px";
        pin.node.style.bottom = "14px";
        pin.node.style.top = "auto";
        continue;
      }
      const r = el.getBoundingClientRect();
      const w = pin.node.offsetWidth || 120;
      const h = pin.node.offsetHeight || 26;
      let left = r.right - w - 8;
      let top = r.top + 8;
      if (r.width === 0 || r.bottom < 0 || r.top > window.innerHeight) {
        pin.node.style.display = "none";
        continue;
      }
      pin.node.style.display = "flex";
      pin.node.style.bottom = "auto";
      pin.node.style.left = `${Math.max(4, left)}px`;
      pin.node.style.top = `${Math.max(4, Math.min(top, window.innerHeight - h - 4))}px`;
      void jobId;
    }
  }

  // ---------- toasts ----------

  function toast(kind, title, msg, ms) {
    ensureUi();
    if (!toastsEl) return;
    const t = document.createElement("div");
    t.className = `toast ${kind || ""}`;
    t.innerHTML = `<div class="tt"></div><div class="tm"></div>`;
    t.querySelector(".tt").textContent = title;
    t.querySelector(".tm").textContent = msg || "";
    if (!msg) t.querySelector(".tm").remove();
    toastsEl.appendChild(t);
    setTimeout(() => t.remove(), ms || (kind === "err" ? 7000 : 3500));
    return t;
  }

  function toastWithAction(kind, title, msg, actionLabel, fn) {
    const t = toast(kind, title, msg, 9000);
    if (!t) return;
    const a = document.createElement("a");
    a.textContent = actionLabel;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      fn();
      t.remove();
    });
    const tm = t.querySelector(".tm") || t;
    tm.appendChild(document.createTextNode(" "));
    tm.appendChild(a);
  }

  // ---------- locate (from popup) ----------

  function locate(itemId) {
    const targets = enumerateTargets();
    const t = targets.find((x) => x.id === itemId);
    if (!t) return false;
    t.el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    setTimeout(() => {
      ensureUi();
      const r = t.el.getBoundingClientRect();
      const f = document.createElement("div");
      f.className = "flash";
      f.style.left = `${r.left - 3}px`;
      f.style.top = `${r.top - 3}px`;
      f.style.width = `${r.width + 6}px`;
      f.style.height = `${r.height + 6}px`;
      root.querySelector(".layer").appendChild(f);
      setTimeout(() => f.remove(), 1700);
    }, 450);
    return true;
  }

  async function listItems() {
    const targets = enumerateTargets().slice(0, 80);
    const out = [];
    for (const t of targets) {
      try {
        const item = await t.adapter.resolve(t);
        if (item) {
          const job = jobForItem(item.id);
          out.push({ ...item, job: job ? { id: job.id, status: job.status, percent: job.percent } : null });
        }
      } catch {}
    }
    return out;
  }

  // ---------- messaging ----------

  function sendToSw(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          if (!res) return resolve(null);
          if (res.ok === false) return reject(new Error(res.error || "error"));
          resolve(res.result !== undefined ? res.result : res);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  // Same isolated world as chrome.scripting.executeScript, which the popup
  // uses (via the service worker) to gather items from every frame at once.
  window.__cb_overlay_list = () => listItems();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "cb-ytdlp-job") {
      const j = msg.job;
      if (j) {
        const prev = jobs.get(j.id);
        const wasTerminal = prev && !["queued", "downloading", "processing"].includes(prev.status);
        upsertJob(j);
        // Only the frame that started the job owns a pin; toasts go to the
        // top frame so they show up once.
        if (IS_TOP && !wasTerminal) {
          if (j.status === "done") {
            toastWithAction("ok", "Saved", j.filepath || j.title || "", "Show in folder", () => {
              sendToSw({ type: "ytdlp-reveal", path: j.filepath }).catch(() => {});
            });
          } else if (j.status === "error") {
            // The service worker explains known failures (lib/download_errors.js);
            // the regex is a fallback for a worker that predates that.
            const err = j.error || "";
            const hint = j.hint || (/sign in to confirm|not a bot/i.test(err)
              ? "Turn on “Use my browser’s cookies” in ComboBreaker options › Downloads, then try again."
              : "");
            const action = j.hint ? j.hintAction : hint ? "options-downloads" : null;
            const title = j.errorTitle || (hint ? "YouTube wants a sign-in check" : "Download failed");
            if (action === "options-downloads") {
              toastWithAction("err", title, hint, "Open options", () =>
                sendToSw({ type: "open-options", section: "downloads" }).catch(() => {}));
            } else {
              toast("err", title, hint || j.errorShort || err.replace(/^yt-dlp exited with code \d+\.\s*/, ""));
            }
          }
        }
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "cb-overlay-list") {
      listItems().then((items) => sendResponse({ ok: true, items, frame: IS_TOP ? "top" : "sub" }));
      return true;
    }
    if (msg.type === "cb-overlay-locate") {
      sendResponse({ ok: locate(msg.id) });
      return;
    }
    if (msg.type === "cb-overlay-state") {
      sendResponse({ ok: true, enabled: ENABLED, site: SITE_KEY });
      return;
    }
  });

  // ---------- boot ----------

  function start() {
    loadSettings();
    document.addEventListener("mousemove", onMove, { capture: true, passive: true });
    // Pointer left the window. Bubble phase on <html> only: a capturing
    // listener on document would fire for every element the pointer leaves.
    document.documentElement.addEventListener("mouseleave", () => {
      if (!menuOpen) scheduleHide(100);
    });
    window.addEventListener(
      "scroll",
      () => {
        if (CURRENT) positionBadge();
        schedulePinLayout();
      },
      { capture: true, passive: true }
    );
    window.addEventListener("resize", () => {
      if (CURRENT) positionBadge();
      schedulePinLayout();
    });
    // Ask the page hook to replay anything it captured before we were listening.
    try {
      document.dispatchEvent(new CustomEvent("cb-media-hook-replay"));
    } catch {}
    // SPAs: re-layout pins when the DOM churns.
    const mo = new MutationObserver(() => schedulePinLayout());
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  function fmtDur(s) {
    const t = Math.round(s);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = t % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  }

  function hostOf(u) {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
