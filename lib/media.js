// Media classification and download file names, shared by the network sniffer
// and the badge / Media tab download paths in background/media.js. Pure.

const MEDIA_URL_RE = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv|ogv|ogg|mp3|m4a|wav|flv|aac|ts)(?:$|\?|#)/i;
const HLS_MIME_RE = /^(application|audio)\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl)/i;
const DASH_MIME_RE = /^application\/dash\+xml/i;

// MIME subtype -> kind, where the subtype is not already the kind.
const SUBTYPE_KIND = {
  quicktime: "mov",
  "x-matroska": "mkv",
  "x-m4v": "mp4",
  "x-m4a": "m4a",
  "x-wav": "wav",
  wave: "wav",
  "vnd.wave": "wav",
  "x-flv": "flv",
  "x-aac": "aac",
  aacp: "aac",
  mp3: "mp3",
  "x-mpeg": "mp3",
};

// Kinds chrome.downloads can simply save; everything else (hls, dash, ytdlp,
// unknown subtypes) needs the Helper or the HLS page.
export const DIRECT_KINDS = new Set(["mp4", "webm", "mov", "mkv", "ogg", "mp3", "m4a", "wav", "flv", "aac", "video", "audio", "mpeg"]);

const KIND_EXT = { video: "mp4", audio: "m4a", mpeg: "mp3", ytdlp: "mp4" };

export function classifyByUrl(url) {
  const m = MEDIA_URL_RE.exec(url || "");
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === "m3u8") return "hls";
  if (ext === "mpd") return "dash";
  if (ext === "m4v") return "mp4";
  if (ext === "ogv") return "ogg";
  return ext;
}

export function classifyByMime(mime) {
  if (!mime) return null;
  const clean = String(mime).split(";")[0].trim().toLowerCase();
  if (HLS_MIME_RE.test(clean)) return "hls";
  if (DASH_MIME_RE.test(clean)) return "dash";
  const m = /^(video|audio)\/(.*)$/.exec(clean);
  if (!m) return null;
  const [, top, sub] = m;
  if (sub === "mp4") return top === "audio" ? "m4a" : "mp4";
  if (sub === "mpeg") return top === "audio" ? "mp3" : "mpeg";
  return SUBTYPE_KIND[sub] || sub || top;
}

// One piece of a segmented stream (HLS .ts / fMP4 .m4s, DASH chunks). These
// arrive by the hundred and are useless on their own; the manifest is what
// gets listed.
export function isStreamSegment(url, mime) {
  const clean = String(mime || "").split(";")[0].trim().toLowerCase();
  if (clean === "video/mp2t" || clean === "video/iso.segment" || clean === "audio/iso.segment") return true;
  let path = String(url || "");
  try {
    path = new URL(path).pathname;
  } catch {
    // keep the raw string
  }
  if (/\.(ts|m4s|m4f|cmfv|cmfa|cmft)$/i.test(path)) return true;
  // seg-12.mp4, chunk_0042.m4a, fragment-3.mp4, init-stream0.mp4 ...
  return /(?:^|[/_.-])(?:seg(?:ment)?|chunk|frag(?:ment)?)[-_]?\d+[^/]*\.(?:mp4|m4a|m4v|aac|webm)$/i.test(path) || /(?:^|[/_-])init[-_.][^/]*\.(?:mp4|m4a|m4v|webm)$/i.test(path);
}

export function safeFilename(s) {
  return String(s || "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

// For a raw sniffed URL: keep the URL's own file name when it is a media
// file name, otherwise build one from the title / host and the detected kind.
export function filenameFromUrl(url, fallbackTitle) {
  try {
    const u = new URL(url);
    let tail = u.pathname.split("/").filter(Boolean).pop() || "";
    try {
      tail = decodeURIComponent(tail);
    } catch {
      // keep it encoded
    }
    if (tail && classifyByUrl(tail)) return safeFilename(tail);
    const ext = (classifyByUrl(url) || "bin").toLowerCase();
    const stem = safeFilename(fallbackTitle || u.hostname || "video");
    return `${stem}.${ext === "mpeg" ? "mp3" : ext}`;
  } catch {
    return safeFilename(fallbackTitle || "download.bin");
  }
}

// For a badge / Media-tab item: "<title> [<tweet id or resolution>].<ext>".
export function filenameForItem(item, source) {
  const raw = classifyByUrl(source.url) || source.kind || "mp4";
  const ext = KIND_EXT[raw] || raw;
  let stem = safeFilename(item && item.title ? item.title : "");
  if (!stem || stem.length < 3) {
    try {
      stem = safeFilename(new URL(item && item.page ? item.page : source.url).hostname);
    } catch {
      stem = "video";
    }
  }
  stem = stem.slice(0, 80);
  let tag = "";
  const m = item && item.page ? /\/status\/(\d+)/.exec(item.page) : null;
  if (m) tag = ` [${m[1]}]`;
  else if (source.res) tag = ` [${source.res}]`;
  return `${stem}${tag}.${ext}`;
}
