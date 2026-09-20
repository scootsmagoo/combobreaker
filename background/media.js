// Media: network/DOM sniffer, direct downloads, on-page badge downloads, HLS page launcher.

import { getGlobal } from "../lib/storage.js";
import {
  classifyByUrl,
  classifyByMime,
  isStreamSegment,
  filenameFromUrl,
  filenameForItem,
  DIRECT_KINDS,
} from "../lib/media.js";
import { ytdlpDownload, ytdlpStatus } from "./ytdlp_bridge.js";

// ---------- Media (video/audio) sniffer ----------
//
// Tracks media URLs seen on each tab so the popup's Media tab can offer
// downloads. Sources:
//   1. content/media_finder.js scans <video>/<source>/<audio> and posts
//      `media-found` messages.
//   2. webRequest.onResponseStarted catches anything the network ships
//      with a media Content-Type or a known media extension.
// Both feed the same per-tab list, deduped by URL. The list lives in
// chrome.storage.session so it survives SW sleeps but resets per browser
// session and per tab navigation.

const MEDIA_KEY = (tabId) => `media:${tabId}`;
const MAX_MEDIA = 50;

export async function pushMediaItem(tabId, item) {
  if (tabId == null || tabId < 0 || !item || !item.url) return null;
  if (typeof item.url !== "string") return null;
  if (item.url.startsWith("blob:") || item.url.startsWith("data:")) return null;

  const key = MEDIA_KEY(tabId);
  const data = await chrome.storage.session.get(key);
  const list = data[key] || [];
  if (list.some((it) => it.url === item.url)) return { added: false };

  const normalized = {
    url: item.url,
    kind: item.kind || classifyByUrl(item.url) || classifyByMime(item.mime) || "video",
    mime: item.mime || "",
    width: item.width || null,
    height: item.height || null,
    duration: item.duration || null,
    title: item.title || "",
    source: item.source || "net",
    time: Date.now(),
  };
  list.push(normalized);
  if (list.length > MAX_MEDIA) list.splice(0, list.length - MAX_MEDIA);
  await chrome.storage.session.set({ [key]: list });
  return { added: true, count: list.length };
}

export async function getMediaList(tabId) {
  if (tabId == null || tabId < 0) return [];
  const key = MEDIA_KEY(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] || [];
}

export async function clearMediaList(tabId) {
  if (tabId == null || tabId < 0) return;
  await chrome.storage.session.remove(MEDIA_KEY(tabId));
  return { ok: true };
}

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.type === "main_frame" || details.type === "sub_frame") return;
    const headers = details.responseHeaders || [];
    const ct = headers.find((h) => h.name.toLowerCase() === "content-type");
    const mime = ct ? String(ct.value || "").trim() : "";
    const kindByMime = classifyByMime(mime);
    const kindByUrl = classifyByUrl(details.url);
    const kind = kindByMime || kindByUrl;
    if (!kind) return;
    // Listing every segment of a stream would bury the list (and push the
    // manifest out of it); the parent .m3u8 / .mpd is what gets tracked.
    if (kindByUrl === "ts" || isStreamSegment(details.url, mime)) return;
    pushMediaItem(details.tabId, {
      url: details.url,
      kind,
      mime,
      source: "net",
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// New top-level navigation = clean slate for the Media tab.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    chrome.storage.session.remove(MEDIA_KEY(details.tabId)).catch(() => {});
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(MEDIA_KEY(tabId)).catch(() => {});
});

// ---------- Direct media download (mp4/webm/etc.) ----------

export async function downloadMedia(url, filename) {
  if (!url || typeof url !== "string") throw new Error("url required");
  const fname = filename || filenameFromUrl(url);
  const id = await chrome.downloads.download({
    url,
    filename: `combobreaker/${fname}`,
    saveAs: false,
    conflictAction: "uniquify",
  });
  return { id, filename: fname };
}

// ---------- On-page badge downloads (content/media_overlay.js) ----------
//
// The overlay hands us an item (what the user hovered) plus the source they
// picked. Direct files go straight to chrome.downloads. Manifests and
// yt-dlp-only sources go to the native bridge when it's installed; otherwise
// HLS falls back to the in-extension downloader page and everything else
// falls back to "copy a yt-dlp command".

export async function overlayDownload(msg, sender) {
  const item = msg.item || {};
  const source = msg.source || {};
  // No explicit preset (badge quick-click) -> the default from options.
  const quality = msg.quality || (await getGlobal()).ytdlp.quality || "best";
  const tabId = msg.tabId != null ? msg.tabId : sender?.tab?.id;
  if (!source.url || !/^https?:/i.test(source.url)) throw new Error("bad source url");

  if (DIRECT_KINDS.has(source.kind)) {
    const r = await downloadMedia(source.url, filenameForItem(item, source));
    return { mode: "direct", filename: r.filename };
  }

  const status = await ytdlpStatus(false);
  if (status.available) {
    const job = await ytdlpDownload({
      url: source.url,
      quality,
      title: item.title || "",
      tabId,
      itemId: item.id,
      page: item.page || msg.referer || "",
      referer: msg.referer || item.page || "",
      thumb: item.thumb || "",
      site: item.site || "",
    });
    return { mode: "ytdlp", jobId: job.id };
  }

  if (source.kind === "hls") {
    await openHlsDownloader(source.url, item.title || "", msg.referer || item.page || "");
    return { mode: "hls-page" };
  }

  // YouTube / DASH without the helper: the page shows a one-time setup prompt.
  return {
    mode: "needs-helper",
    reason: status.error || "Helper not installed.",
    // "Installed but broken" asks for a repair; a missing permission is just "not set up yet".
    installed: !status.needsPermission && !/not installed/i.test(status.error || ""),
  };
}

export async function openHelperSetup() {
  const url = chrome.runtime.getURL("viewer/helper_setup.html");
  // Reuse an open setup tab instead of stacking them.
  const open = await chrome.tabs.query({ url });
  if (open.length) {
    await chrome.tabs.update(open[0].id, { active: true });
    try { await chrome.windows.update(open[0].windowId, { focused: true }); } catch {}
    return { tabId: open[0].id };
  }
  const tab = await chrome.tabs.create({ url });
  return { tabId: tab.id };
}

// Collect badge items from every frame of a tab. chrome.scripting runs in the
// same isolated world as the content script, so the function can call the
// hook media_overlay.js leaves on window.
export async function overlayListAllFrames(tabId) {
  if (tabId == null || tabId < 0) return [];
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (typeof window.__cb_overlay_list === "function" ? window.__cb_overlay_list() : null),
    });
  } catch (e) {
    throw new Error(`no access to this page (${e.message})`);
  }
  const out = [];
  const seen = new Set();
  for (const r of results) {
    if (!r || !Array.isArray(r.result)) continue;
    for (const it of r.result) {
      const key = `${r.frameId}:${it.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...it, frameId: r.frameId });
    }
  }
  // Top frame first, then document order within each frame.
  out.sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : a.frameId - b.frameId));
  return out;
}

export async function openOptionsSection(section) {
  const url = chrome.runtime.getURL(`options/options.html${section ? "#" + section : ""}`);
  const tab = await chrome.tabs.create({ url });
  return { tabId: tab.id };
}

// ---------- HLS downloader page launcher ----------

export async function openHlsDownloader(url, title, referer) {
  if (!url) throw new Error("hls url required");
  const params = new URLSearchParams({ url });
  if (title) params.set("title", title);
  if (referer) params.set("referer", referer);
  const dest = chrome.runtime.getURL(
    `viewer/hls_downloader.html?${params.toString()}`
  );
  const tab = await chrome.tabs.create({ url: dest });
  return { tabId: tab.id };
}
