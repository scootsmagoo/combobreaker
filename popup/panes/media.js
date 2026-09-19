// Media pane: videos on the page, Helper (yt-dlp) status and jobs, raw sniffed URLs.

import { $, STATE, sendMessage, status, escapeHtml, badge } from "../shared.js";

const QUALITY_PRESETS = [
  ["best", "Best"],
  ["1080", "1080p"],
  ["720", "720p"],
  ["480", "480p"],
  ["audio", "Audio (MP3)"],
];

const MEDIA = {
  bridge: null, // result of ytdlp-status
  items: [], // videos on the page (from content/media_overlay.js)
  jobs: [], // yt-dlp jobs (from the bridge)
  overlaySite: null, // true | false | null
  overlayGlobal: true,
};

export function bindMediaPane() {
  $("media-refresh").addEventListener("click", async () => {
    if (!STATE.tab) return;
    try {
      await chrome.tabs.sendMessage(STATE.tab.id, { type: "cb-media-rescan" });
    } catch {
      // Content script may not be present (chrome:// etc.) — fine.
    }
    setTimeout(() => loadMedia(true), 300);
  });
  $("media-clear").addEventListener("click", async () => {
    if (!STATE.tab) return;
    try {
      await sendMessage({ type: "media-clear", tabId: STATE.tab.id });
      await sendMessage({ type: "ytdlp-clear-jobs" });
      status("Media list cleared", "ok");
      loadMedia(true);
    } catch (e) {
      status(`Clear failed: ${e.message}`, "err");
    }
  });
  $("media-ytdlp").addEventListener("click", copyYtDlp);
  $("bridge-setup").addEventListener("click", () => {
    sendMessage({ type: "open-helper-setup" }).catch(() => {});
    window.close();
  });
  $("bridge-recheck").addEventListener("click", () => checkBridge(true));
  $("media-jobs-clear").addEventListener("click", async () => {
    try {
      await sendMessage({ type: "ytdlp-clear-jobs" });
      loadJobs();
    } catch (e) {
      status(`Failed: ${e.message}`, "err");
    }
  });

  $("t-overlay-global").addEventListener("change", async (e) => {
    MEDIA.overlayGlobal = e.target.checked;
    try {
      await sendMessage({ type: "set-global", patch: { mediaOverlayEnabled: MEDIA.overlayGlobal } });
      status(`Badges ${MEDIA.overlayGlobal ? "on" : "off"} by default`, "ok");
    } catch (err) {
      status(`Failed: ${err.message}`, "err");
    }
    renderOverlayToggles();
  });
  $("t-overlay-site").addEventListener("change", async (e) => {
    if (!STATE.siteKey) return;
    const want = e.target.checked;
    // Store an explicit value only when it differs from the global default.
    const value = want === MEDIA.overlayGlobal ? null : want;
    MEDIA.overlaySite = value;
    try {
      await sendMessage({ type: "set-site", siteKey: STATE.siteKey, patch: { mediaOverlay: value } });
      status(`Badges ${want ? "on" : "off"} for ${STATE.siteKey}`, "ok");
    } catch (err) {
      status(`Failed: ${err.message}`, "err");
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "cb-ytdlp-job" && msg.job) {
      const i = MEDIA.jobs.findIndex((j) => j.id === msg.job.id);
      if (i >= 0) MEDIA.jobs[i] = { ...MEDIA.jobs[i], ...msg.job };
      else MEDIA.jobs.unshift(msg.job);
      if (STATE.activeTab === "media") {
        renderJobs();
        renderVideoProgress();
      }
    }
  });
}

export async function loadMedia(_force = false) {
  if (!STATE.tab) return;
  MEDIA.overlayGlobal = STATE.global ? STATE.global.mediaOverlayEnabled !== false : true;
  MEDIA.overlaySite = STATE.settings ? STATE.settings.mediaOverlay ?? null : null;
  renderOverlayToggles();
  checkBridge(false);
  loadJobs();
  loadVideos();
  loadRaw();
}

function renderOverlayToggles() {
  const g = MEDIA.overlayGlobal;
  const s = MEDIA.overlaySite;
  $("t-overlay-global").checked = !!g;
  $("t-overlay-site").checked = s === true ? true : s === false ? false : !!g;
  $("t-overlay-site").disabled = !STATE.siteKey;
}

//  yt-dlp bridge status

async function checkBridge(force) {
  const dot = $("bridge-dot");
  const text = $("bridge-text");
  const setup = $("bridge-setup");
  if (force) {
    dot.className = "bridge-dot";
    text.textContent = "Checking the Helper…";
  }
  try {
    MEDIA.bridge = await sendMessage({ type: "ytdlp-status", force: !!force });
  } catch (e) {
    MEDIA.bridge = { available: false, error: String(e.message || e) };
  }
  const b = MEDIA.bridge || {};
  if (b.available) {
    dot.className = `bridge-dot ${b.ffmpeg ? "ok" : "warn"}`;
    text.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = "Helper connected";
    text.appendChild(strong);
    text.appendChild(document.createTextNode(` · yt-dlp ${b.ytdlp && b.ytdlp.version ? b.ytdlp.version : ""}`.trimEnd() + (b.ffmpeg ? "" : " · ffmpeg missing")));
    text.title = [b.ytdlp && (b.ytdlp.display || b.ytdlp.path), b.ffmpeg && b.ffmpeg.path, b.outputDir && `→ ${b.outputDir}`]
      .filter(Boolean)
      .join("\n");
    setup.hidden = true;
  } else {
    const notInstalled = /not installed/i.test(b.error || "");
    dot.className = "bridge-dot err";
    text.textContent = notInstalled ? "Helper not set up · needed for YouTube" : `Helper: ${b.error || "not installed"}`;
    text.title = b.error || "";
    setup.textContent = notInstalled ? "Set up" : "Repair";
    setup.hidden = false;
  }
  if (MEDIA.items.length) renderVideos();
}

//  Videos on the page

async function loadVideos() {
  const wrap = $("media-videos");
  const hint = $("media-videos-hint");
  wrap.innerHTML = `<div class="empty muted">Scanning…</div>`;
  hint.textContent = "";
  let items = null;
  try {
    items = await sendMessage({ type: "overlay-list-all", tabId: STATE.tab.id });
  } catch {
    items = null;
  }
  MEDIA.items = items || [];
  if (!items) {
    wrap.innerHTML = `<div class="empty muted">No access to this page (chrome://, PDF, or the tab needs a reload after installing ComboBreaker).</div>`;
    return;
  }
  renderVideos();
}

function renderVideos() {
  const wrap = $("media-videos");
  const hint = $("media-videos-hint");
  const items = MEDIA.items;
  $("media-count").textContent = items.length ? `${items.length} video${items.length === 1 ? "" : "s"}` : "—";
  if (!items.length) {
    wrap.innerHTML = `<div class="empty muted">No videos found. Hover a player or thumbnail on the page to get a download badge; play the video if it loads lazily.</div>`;
    return;
  }
  hint.textContent = items.length > 1 ? "click a title to find it on the page" : "";
  wrap.innerHTML = "";
  for (const it of items) wrap.appendChild(renderVideoRow(it));
}

function primarySourceOf(it) {
  const order = ["mp4", "webm", "mov", "mkv", "ogg", "hls", "dash", "mp3", "m4a", "video", "ytdlp"];
  let best = null;
  let br = 99;
  for (const s of it.sources || []) {
    const r = order.indexOf(s.kind);
    const rank = r < 0 ? 50 : r;
    if (rank < br) {
      best = s;
      br = rank;
    }
  }
  return best;
}

function renderVideoRow(it) {
  const row = document.createElement("div");
  row.className = "media-video";
  row.dataset.itemId = it.id;

  let thumb;
  if (it.thumb && /^https?:/.test(it.thumb)) {
    thumb = document.createElement("img");
    thumb.className = "thumb";
    thumb.src = it.thumb;
    thumb.alt = "";
    thumb.referrerPolicy = "no-referrer";
    thumb.addEventListener("error", () => {
      const ph = placeholderThumb();
      thumb.replaceWith(ph);
    });
  } else {
    thumb = placeholderThumb();
  }
  thumb.title = "Find on page";
  thumb.addEventListener("click", () => locateItem(it.id, it.frameId));
  row.appendChild(thumb);

  const info = document.createElement("div");
  info.className = "info";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = it.title || it.page || it.id;
  title.title = `${it.title || ""}\n${it.page || ""}\n(click to find on page)`.trim();
  title.addEventListener("click", () => locateItem(it.id, it.frameId));
  info.appendChild(title);
  const meta = document.createElement("div");
  meta.className = "meta";
  if (it.site && it.site !== "generic") meta.appendChild(badge(it.site === "twitter" ? "X" : it.site));
  if (it.frameId) meta.appendChild(badge("embed"));
  if (it.width && it.height) meta.appendChild(badge(`${it.width}×${it.height}`));
  if (it.duration) meta.appendChild(badge(formatDurationShort(it.duration)));
  if (it.gif) meta.appendChild(badge("GIF"));
  const kinds = [...new Set((it.sources || []).map((s) => s.kind))].filter((k) => k !== "ytdlp");
  for (const k of kinds.slice(0, 3)) meta.appendChild(badge(k.toUpperCase()));
  if (!kinds.length) meta.appendChild(badge("via Helper"));
  info.appendChild(meta);
  row.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "actions";
  const primary = primarySourceOf(it);
  const bridgeOk = !!(MEDIA.bridge && MEDIA.bridge.available);
  const directSources = (it.sources || []).filter((s) => !["ytdlp", "hls", "dash"].includes(s.kind));
  const ytd = (it.sources || []).find((s) => s.kind === "ytdlp");

  if (primary && directSources.length) {
    let picked = directSources[0];
    if (directSources.length > 1) {
      const sel = document.createElement("select");
      sel.className = "q";
      sel.title = "Pick a variant";
      directSources.forEach((s, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = [s.res || s.label, s.bitrate ? `${(s.bitrate / 1e6).toFixed(1)}M` : ""].filter(Boolean).join(" ");
        sel.appendChild(o);
      });
      sel.addEventListener("change", () => (picked = directSources[Number(sel.value)]));
      actions.appendChild(sel);
    }
    const dl = document.createElement("button");
    dl.className = "media-btn primary";
    dl.textContent = "Download";
    dl.addEventListener("click", () => overlayDownloadFromPopup(it, picked, "best"));
    actions.appendChild(dl);
  } else if (bridgeOk && (ytd || primary)) {
    const sel = document.createElement("select");
    sel.className = "q";
    for (const [q, label] of QUALITY_PRESETS) {
      if (q === "audio" && !(MEDIA.bridge && MEDIA.bridge.ffmpeg)) continue;
      const o = document.createElement("option");
      o.value = q;
      o.textContent = label;
      sel.appendChild(o);
    }
    const def = STATE.global && STATE.global.ytdlp && STATE.global.ytdlp.quality;
    if (def && [...sel.options].some((o) => o.value === def)) sel.value = def;
    actions.appendChild(sel);
    const dl = document.createElement("button");
    dl.className = "media-btn primary";
    dl.textContent = "Download";
    const src = primary && primary.kind !== "ytdlp" ? primary : ytd;
    dl.addEventListener("click", () => overlayDownloadFromPopup(it, src, sel.value));
    actions.appendChild(dl);
  } else if (primary && primary.kind === "hls") {
    const dl = document.createElement("button");
    dl.className = "media-btn primary";
    dl.textContent = "HLS ↗";
    dl.title = "Open the HLS downloader";
    dl.addEventListener("click", () => openHlsDownloader({ url: primary.url, title: it.title }));
    actions.appendChild(dl);
  } else if (ytd) {
    const cp = document.createElement("button");
    cp.className = "media-btn primary";
    cp.textContent = "Set up ↗";
    cp.title = "One-time setup: this site needs the ComboBreaker Helper";
    cp.addEventListener("click", async () => {
      try {
        await sendMessage({ type: "open-helper-setup" });
        window.close();
      } catch (e) {
        status(`Couldn't open setup: ${e.message}`, "err");
      }
    });
    actions.appendChild(cp);
  }

  const open = document.createElement("button");
  open.className = "media-btn";
  open.textContent = "↗";
  open.title = primary && primary.kind !== "ytdlp" ? "Open media URL in a new tab" : "Open page in a new tab";
  open.addEventListener("click", () =>
    chrome.tabs.create({ url: primary && primary.kind !== "ytdlp" ? primary.url : it.page, active: false })
  );
  actions.appendChild(open);
  row.appendChild(actions);

  const job = jobForItem(it.id);
  if (job && isJobActive(job)) {
    const p = document.createElement("div");
    p.className = "progress";
    p.innerHTML = "<i></i>";
    p.querySelector("i").style.width = `${job.percent || 0}%`;
    row.appendChild(p);
  }
  return row;
}

function placeholderThumb() {
  const d = document.createElement("div");
  d.className = "thumb empty";
  d.textContent = "▶";
  return d;
}

async function locateItem(id, frameId = 0) {
  if (!STATE.tab) return;
  try {
    const r = await chrome.tabs.sendMessage(STATE.tab.id, { type: "cb-overlay-locate", id }, { frameId: frameId || 0 });
    if (r && r.ok) status("Highlighted on page", "ok");
    else status("Couldn't find it on the page anymore", "err");
  } catch (e) {
    status(`Locate failed: ${e.message}`, "err");
  }
}

async function overlayDownloadFromPopup(it, source, quality) {
  if (!source) return;
  try {
    const direct = !["ytdlp", "hls", "dash"].includes(source.kind);
    if (direct) {
      // Same naming path as the on-page badge (service worker owns it).
      await sendMessage({
        type: "overlay-download",
        tabId: STATE.tab.id,
        item: { id: it.id, title: it.title, page: it.page, thumb: it.thumb, site: it.site },
        source: { kind: source.kind, url: source.url, res: source.res || "" },
        referer: STATE.tab.url,
      });
      status("Download started", "ok");
      return;
    }
    const bridgeOk = !!(MEDIA.bridge && MEDIA.bridge.available);
    if (!bridgeOk) {
      if (source.kind === "hls") return openHlsDownloader({ url: source.url, title: it.title });
      await sendMessage({ type: "open-helper-setup" });
      window.close();
      return;
    }
    const job = await sendMessage({
      type: "ytdlp-download",
      url: source.url,
      quality: quality || "best",
      title: it.title || "",
      tabId: STATE.tab.id,
      itemId: it.id,
      page: it.page,
      referer: STATE.tab.url,
      thumb: it.thumb,
      site: it.site,
    });
    if (job) {
      MEDIA.jobs.unshift(job);
      renderJobs();
      renderVideoProgress();
    }
    status("Download started", "ok");
  } catch (e) {
    status(`Download failed: ${e.message}`, "err");
  }
}


function renderVideoProgress() {
  for (const row of document.querySelectorAll(".media-video")) {
    const job = jobForItem(row.dataset.itemId);
    let p = row.querySelector(".progress");
    if (job && isJobActive(job)) {
      if (!p) {
        p = document.createElement("div");
        p.className = "progress";
        p.innerHTML = "<i></i>";
        row.appendChild(p);
      }
      p.querySelector("i").style.width = `${job.percent || 0}%`;
    } else if (p) {
      p.remove();
    }
  }
}

//  yt-dlp jobs

function isJobActive(j) {
  return j && (j.status === "queued" || j.status === "downloading" || j.status === "processing");
}

function jobForItem(itemId) {
  if (!itemId) return null;
  let latest = null;
  for (const j of MEDIA.jobs) {
    if (j.itemId === itemId && (!latest || (j.updated || 0) > (latest.updated || 0))) latest = j;
  }
  return latest;
}

async function loadJobs() {
  try {
    MEDIA.jobs = (await sendMessage({ type: "ytdlp-jobs" })) || [];
  } catch {
    MEDIA.jobs = [];
  }
  renderJobs();
}

function renderJobs() {
  const wrap = $("media-jobs-wrap");
  const list = $("media-jobs");
  const jobs = [...MEDIA.jobs].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  wrap.hidden = jobs.length === 0;
  list.innerHTML = "";
  for (const j of jobs.slice(0, 12)) list.appendChild(renderJobRow(j));
}

function renderJobRow(j) {
  const row = document.createElement("div");
  row.className = "media-job";
  const t = document.createElement("div");
  t.className = "jt";
  t.textContent = j.title || j.url;
  t.title = j.url || "";
  row.appendChild(t);

  const a = document.createElement("div");
  a.className = "ja";
  if (isJobActive(j)) {
    const c = document.createElement("button");
    c.className = "media-btn";
    c.textContent = "Cancel";
    c.addEventListener("click", async () => {
      c.disabled = true;
      try {
        await sendMessage({ type: "ytdlp-cancel", jobId: j.id });
      } catch (e) {
        status(`Cancel failed: ${e.message}`, "err");
      }
    });
    a.appendChild(c);
  } else if (j.status === "done" && j.filepath) {
    const f = document.createElement("button");
    f.className = "media-btn";
    f.textContent = "Folder";
    f.title = j.filepath;
    f.addEventListener("click", () => sendMessage({ type: "ytdlp-reveal", path: j.filepath }).catch(() => {}));
    a.appendChild(f);
  } else if (j.status === "error") {
    const r = document.createElement("button");
    r.className = "media-btn";
    r.textContent = "Retry";
    r.addEventListener("click", () =>
      overlayDownloadFromPopup(
        { id: j.itemId, title: j.title, page: j.page, thumb: j.thumb, site: j.site },
        { kind: "ytdlp", url: j.url },
        j.quality
      )
    );
    a.appendChild(r);
  }
  row.appendChild(a);

  const s = document.createElement("div");
  s.className = "js";
  let text = "";
  if (j.status === "queued") text = "Starting…";
  else if (j.status === "downloading") {
    const bits = [];
    if (j.percent != null) bits.push(`${Math.round(j.percent)}%`);
    if (j.total) bits.push(formatBytesShort(j.total));
    if (j.speed) bits.push(`${formatBytesShort(j.speed)}/s`);
    if (j.eta != null && j.eta > 0) bits.push(`eta ${formatDurationShort(j.eta)}`);
    text = bits.join(" · ") || "Downloading…";
  } else if (j.status === "processing") text = `Merging (${j.stage || "ffmpeg"})…`;
  else if (j.status === "done") {
    text = j.filepath || "Saved";
    s.classList.add("ok");
  } else if (j.status === "error") {
    text = j.error || "Failed";
    s.classList.add("err");
  } else if (j.status === "cancelled") text = "Cancelled";
  s.textContent = text;
  s.title = text;
  row.appendChild(s);

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.innerHTML = "<i></i>";
  if (j.status === "done") {
    bar.classList.add("done");
    bar.querySelector("i").style.width = "100%";
  } else if (j.status === "error") bar.classList.add("err");
  else if (j.status === "processing" || j.status === "queued") bar.classList.add("busy");
  else bar.querySelector("i").style.width = `${j.percent || 0}%`;
  row.appendChild(bar);
  return row;
}

function formatBytesShort(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

//  Raw URL list (network sniff + DOM scan)

async function loadRaw() {
  const list = $("media-list");
  try {
    const items = await sendMessage({ type: "media-list", tabId: STATE.tab.id });
    renderMedia(items);
  } catch (e) {
    list.innerHTML = `<div class="empty muted">Error: ${escapeHtml(String(e.message || e))}</div>`;
  }
}

function renderMedia(items) {
  const list = $("media-list");
  $("media-raw-count").textContent = items.length ? `(${items.length})` : "";
  if (!items.length) {
    list.innerHTML = `<div class="empty muted">Nothing sniffed yet. Play the video and re-open this popup.</div>`;
    return;
  }
  list.innerHTML = "";
  const sorted = [...items].sort(mediaSortKey);
  for (const it of sorted) {
    list.appendChild(renderMediaItem(it));
  }
}

function mediaSortKey(a, b) {
  const rank = (k) => {
    if (k === "mp4" || k === "webm" || k === "mov" || k === "mkv") return 0;
    if (k === "hls") return 1;
    if (k === "dash") return 2;
    return 3;
  };
  const ra = rank(a.kind);
  const rb = rank(b.kind);
  if (ra !== rb) return ra - rb;
  return (b.time || 0) - (a.time || 0);
}

function renderMediaItem(it) {
  const row = document.createElement("div");
  row.className = "media-item";

  const kind = document.createElement("span");
  kind.className = `kind ${it.kind || ""}`;
  kind.textContent = (it.kind || "?").toUpperCase();
  row.appendChild(kind);

  const info = document.createElement("div");
  info.className = "info";
  const url = document.createElement("div");
  url.className = "url";
  url.textContent = shortUrl(it.url);
  url.title = `${it.url}\n(click to copy)`;
  url.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(it.url);
      status("URL copied", "ok");
    } catch {}
  });
  info.appendChild(url);

  const meta = document.createElement("div");
  meta.className = "meta";
  if (it.width && it.height) meta.appendChild(badge(`${it.width}×${it.height}`));
  if (it.duration) meta.appendChild(badge(formatDurationShort(it.duration)));
  if (it.mime) meta.appendChild(badge(it.mime.split(";")[0]));
  meta.appendChild(badge(it.source === "dom" ? "from DOM" : "from network"));
  info.appendChild(meta);
  row.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "actions";
  const bridgeOk = !!(MEDIA.bridge && MEDIA.bridge.available);

  if (it.kind === "hls" || it.kind === "dash") {
    if (bridgeOk) {
      const dl = document.createElement("button");
      dl.className = "media-btn primary";
      dl.textContent = "Download";
      dl.title = "Download this stream through the Helper";
      dl.addEventListener("click", () =>
        overlayDownloadFromPopup(
          { id: `raw:${it.url}`, title: it.title || (STATE.tab && STATE.tab.title) || "", page: STATE.tab.url },
          { kind: it.kind, url: it.url },
          "best"
        )
      );
      actions.appendChild(dl);
    }
    if (it.kind === "hls") {
      const dl = document.createElement("button");
      dl.className = bridgeOk ? "media-btn" : "media-btn primary";
      dl.textContent = "HLS ↗";
      dl.title = "Open the in-extension HLS downloader";
      dl.addEventListener("click", () => openHlsDownloader(it));
      actions.appendChild(dl);
    } else if (!bridgeOk) {
      const note = document.createElement("button");
      note.className = "media-btn";
      note.textContent = "DASH";
      note.disabled = true;
      note.title = "DASH (.mpd) needs the Helper (set it up above).";
      actions.appendChild(note);
    }
  } else {
    const dl = document.createElement("button");
    dl.className = "media-btn primary";
    dl.textContent = "Download";
    dl.addEventListener("click", () => downloadDirect(it));
    actions.appendChild(dl);
  }

  const open = document.createElement("button");
  open.className = "media-btn";
  open.textContent = "↗";
  open.title = "Open URL in a new tab";
  open.addEventListener("click", () => chrome.tabs.create({ url: it.url, active: false }));
  actions.appendChild(open);

  row.appendChild(actions);
  return row;
}

async function downloadDirect(it) {
  try {
    await sendMessage({ type: "media-download", url: it.url });
    status("Download started", "ok");
  } catch (e) {
    status(`Download failed: ${e.message}`, "err");
  }
}

async function openHlsDownloader(it) {
  try {
    await sendMessage({
      type: "open-hls-downloader",
      url: it.url,
      title: it.title || (STATE.tab && STATE.tab.title) || "",
      referer: STATE.tab && STATE.tab.url ? STATE.tab.url : "",
    });
    window.close();
  } catch (e) {
    status(`Couldn't open downloader: ${e.message}`, "err");
  }
}

async function copyYtDlp() {
  if (!STATE.tab || !STATE.tab.url) {
    status("No tab URL", "err");
    return;
  }
  const cmd = `yt-dlp "${STATE.tab.url}"`;
  try {
    await navigator.clipboard.writeText(cmd);
    status("yt-dlp command copied", "ok");
  } catch (e) {
    status(`Copy failed: ${e.message}`, "err");
  }
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    let path = x.pathname;
    if (path.length > 60) path = "…" + path.slice(-58);
    return `${x.host}${path}`;
  } catch {
    return u;
  }
}

function formatDurationShort(s) {
  if (!s || !isFinite(s)) return "";
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
