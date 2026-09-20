// HLS downloader page.
//
// Pulls an .m3u8 manifest, optionally lets the user pick a variant from a
// master playlist, then fetches every media segment in series and writes
// the concatenated MPEG-TS bytes to disk via chrome.downloads.
//
// What's intentionally NOT supported:
//   - DRM (EME / Widevine / FairPlay).
//   - AES-128 encrypted segments. We could decrypt, but the typical use
//     case (free-to-air HLS) is unencrypted; refusing here is safer than
//     silently producing garbage.
//   - fMP4-only streams (segments are .m4s with an init segment). Raw
//     concat doesn't yield a valid file. Detected and refused with a
//     hint to use ffmpeg.wasm (which would need to be vendored).
//   - Live streams: we grab the *current* sliding window only.

import { parseM3u8, detectContainer, rangeHeader } from "../lib/hls.js";

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const SOURCE_URL = params.get("url") || "";
const SOURCE_TITLE = params.get("title") || "";
const REFERER = params.get("referer") || "";

const STATE = {
  baseUrl: SOURCE_URL,
  variants: [],
  segments: [],
  encryption: null,
  initSegmentUrl: null,
  cancelled: false,
  container: "ts",
  isLive: false,
};

init().catch(showFatal);

async function init() {
  $("src-url").textContent = SOURCE_URL || "(no URL)";
  $("src-title").textContent = SOURCE_TITLE || "—";
  document.title = `HLS · ${SOURCE_TITLE || hostnameOf(SOURCE_URL) || "download"}`;

  if (!SOURCE_URL) throw new Error("No HLS URL provided.");
  if (!/^https?:/i.test(SOURCE_URL)) throw new Error("Only http(s) URLs supported.");

  const text = await fetchText(SOURCE_URL);
  const parsed = parseM3u8(text, SOURCE_URL);

  if (parsed.kind === "master") {
    STATE.variants = parsed.variants;
    STATE.hasSeparateAudio = !!parsed.hasSeparateAudio;
    renderVariants(parsed.variants);
  } else {
    await prepareMediaPlaylist(parsed, SOURCE_URL, text);
  }
  offerBridge().catch(() => {});
}

// If the yt-dlp bridge is installed, offer it: yt-dlp handles fMP4, separate
// audio renditions, AES-128 and DASH, and writes a proper .mp4.
async function offerBridge() {
  const status = await sendToSw({ type: "ytdlp-status" });
  if (!status || !status.available) return;
  const panel = $("bridge-panel");
  panel.hidden = false;
  $("bridge-btn").onclick = async () => {
    $("bridge-btn").disabled = true;
    try {
      await sendToSw({
        type: "ytdlp-download",
        url: SOURCE_URL,
        quality: "best",
        title: SOURCE_TITLE,
        page: REFERER,
        referer: REFERER,
      });
      $("bridge-note").textContent = "Started. Progress shows in the ComboBreaker popup (Media tab).";
    } catch (e) {
      $("bridge-note").textContent = `Failed: ${e.message}`;
      $("bridge-btn").disabled = false;
    }
  };
}

function sendToSw(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res || res.ok === false) return reject(new Error((res && res.error) || "error"));
      resolve(res.result);
    });
  });
}

function renderVariants(variants) {
  const list = $("variants-list");
  list.innerHTML = "";
  variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  for (const v of variants) {
    const row = document.createElement("div");
    row.className = "variant";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.textContent = formatVariantTitle(v);
    title.style.fontWeight = "600";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = formatVariantMeta(v);
    left.appendChild(title);
    left.appendChild(meta);
    const btn = document.createElement("button");
    btn.className = "pick";
    btn.textContent = "Pick";
    btn.addEventListener("click", () => loadVariant(v));
    row.appendChild(left);
    row.appendChild(btn);
    list.appendChild(row);
  }
  $("variants-panel").hidden = false;
}

function formatVariantTitle(v) {
  if (v.resolution) return v.resolution;
  if (v.bandwidth) return `${Math.round(v.bandwidth / 1000)} kbps`;
  return "Variant";
}

function formatVariantMeta(v) {
  const bits = [];
  if (v.bandwidth) bits.push(`${Math.round(v.bandwidth / 1000)} kbps`);
  if (v.codecs) bits.push(v.codecs);
  if (v.frameRate) bits.push(`${v.frameRate} fps`);
  return bits.join(" · ");
}

async function loadVariant(v) {
  $("variants-panel").hidden = true;
  const text = await fetchText(v.url);
  const parsed = parseM3u8(text, v.url);
  if (parsed.kind !== "media") throw new Error("Variant did not point to a media playlist.");
  await prepareMediaPlaylist(parsed, v.url, text);
}

async function prepareMediaPlaylist(parsed, playlistUrl, _rawText) {
  STATE.baseUrl = playlistUrl;
  STATE.segments = parsed.segments;
  STATE.encryption = parsed.encryption;
  STATE.initSegmentUrl = parsed.initSegmentUrl;
  STATE.initSegment = parsed.initSegment;
  STATE.isLive = !parsed.endlist;
  STATE.container = detectContainer(parsed);

  $("info-segments").textContent = String(parsed.segments.length);
  $("info-duration").textContent = parsed.totalDuration
    ? formatDuration(parsed.totalDuration)
    : "—";
  $("info-container").textContent = STATE.container.toUpperCase();
  $("info-encryption").textContent = parsed.encryption
    ? parsed.encryption.method
    : "none";
  $("info-live").textContent = STATE.isLive ? "yes (current window only)" : "no";

  const baseName = SOURCE_TITLE || hostnameOf(playlistUrl) || "video";
  $("filename").value = `${safeFilename(baseName)}.${STATE.container === "fmp4" ? "mp4" : "ts"}`;

  $("info-panel").hidden = false;

  $("start-btn").disabled = false;
  $("start-btn").onclick = startDownload;

  if (parsed.encryption && parsed.encryption.method !== "NONE") {
    $("start-btn").disabled = true;
    showFatal(
      `This stream uses ${parsed.encryption.method} encryption. ` +
        `ComboBreaker doesn't decrypt HLS. The stream is probably DRM-protected.`
    );
  } else if (STATE.container === "fmp4") {
    // A single-track fMP4 rendition is just init segment + media segments;
    // concatenating them in order yields a valid fragmented MP4. What we
    // can't do is mux a separate audio rendition in; warn when the master
    // playlist advertised one.
    if (STATE.hasSeparateAudio) {
      log(
        "Warning: this playlist keeps audio in a separate track. The file will be " +
          "video-only. For a merged file use the yt-dlp bridge (button above) or run " +
          `ffmpeg -i "${playlistUrl}" -c copy out.mp4`
      );
    } else {
      log("fMP4 stream: init segment + media segments will be concatenated into an .mp4.");
    }
  } else if (STATE.isLive) {
    log("Note: live stream. Only the current window of segments will be captured.");
  }
  if (parsed.segments.some((seg) => seg.range)) {
    log("Byte-range playlist: each segment is fetched as its own range of the media file.");
  }
  if (parsed.mapCount > 1) {
    log(
      "Warning: the stream switches format part-way (several init segments, usually an ad break). " +
        "Only the first is used, so the file may stop playing at the switch. The Helper handles this properly."
    );
  }
}

async function startDownload() {
  $("info-panel").hidden = true;
  $("progress-panel").hidden = false;
  $("error-panel").hidden = true;
  STATE.cancelled = false;

  $("cancel-btn").onclick = () => {
    STATE.cancelled = true;
    log("Cancelled by user.");
  };

  const segments = STATE.segments;
  const total = segments.length;
  if (!total) throw new Error("No segments to download.");

  const chunks = [];
  let bytesSoFar = 0;
  const startedAt = performance.now();
  let lastUpdate = 0;

  if (STATE.initSegmentUrl) {
    log("Fetching init segment…");
    const init = await fetchBytes(STATE.initSegmentUrl, STATE.initSegment && STATE.initSegment.range);
    chunks.push(init);
    bytesSoFar += init.byteLength;
  }

  for (let i = 0; i < total; i++) {
    if (STATE.cancelled) {
      log(`Stopped at segment ${i + 1}/${total}.`);
      $("progress-panel").hidden = true;
      return;
    }
    const seg = segments[i];
    let buf;
    try {
      buf = await fetchBytes(seg.url, seg.range);
    } catch (e) {
      log(`Segment ${i + 1} failed: ${e.message}. Retrying once…`);
      try {
        buf = await fetchBytes(seg.url, seg.range);
      } catch (e2) {
        throw new Error(`Segment ${i + 1}/${total} failed: ${e2.message}`);
      }
    }
    chunks.push(buf);
    bytesSoFar += buf.byteLength;

    const now = performance.now();
    if (now - lastUpdate > 80 || i === total - 1) {
      lastUpdate = now;
      const pct = ((i + 1) / total) * 100;
      $("progress-fill").style.width = `${pct.toFixed(1)}%`;
      $("progress-text").textContent = `${i + 1} / ${total} segments · ${formatBytes(bytesSoFar)}`;
      const elapsed = (now - startedAt) / 1000;
      const speed = elapsed > 0 ? bytesSoFar / elapsed : 0;
      $("progress-speed").textContent = `${formatBytes(speed)}/s`;
    }
  }

  log(`Concatenated ${total} segments → ${formatBytes(bytesSoFar)}.`);

  const isMp4 = STATE.container === "fmp4";
  const filename = $("filename").value || `combobreaker-hls-${Date.now()}.${isMp4 ? "mp4" : "ts"}`;
  const blob = new Blob(chunks, { type: isMp4 ? "video/mp4" : "video/mp2t" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: `combobreaker/${safeFilename(filename)}`,
      saveAs: true,
      conflictAction: "uniquify",
    });
    log(`Saved as ${filename}.`);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

// ---------- Network ----------

async function fetchText(url) {
  const r = await fetch(url, fetchOpts());
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} fetching ${url}`);
  return await r.text();
}

// range: a segment's { offset, length } from #EXT-X-BYTERANGE, or null.
async function fetchBytes(url, range) {
  const opts = fetchOpts();
  const header = rangeHeader(range);
  if (header) opts.headers = { Range: header };
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  const buf = await r.arrayBuffer();
  // A server that ignores Range answers 200 with the whole file; cut the
  // piece out rather than writing the file once per segment.
  if (header && r.status === 200 && buf.byteLength > range.length) {
    return buf.slice(range.offset, range.offset + range.length);
  }
  return buf;
}

function fetchOpts() {
  // Extension pages have <all_urls> host permission, so cross-origin
  // fetches succeed without CORS preflights, but we omit credentials so
  // we don't accidentally leak the user's session cookies to CDNs.
  return {
    credentials: "omit",
    referrer: REFERER || undefined,
    referrerPolicy: REFERER ? "origin" : "no-referrer",
  };
}

// ---------- UI helpers ----------

function showFatal(err) {
  const text = err && err.message ? err.message : String(err);
  $("error-text").textContent = text;
  $("error-panel").hidden = false;
  $("retry-btn").onclick = () => location.reload();
  console.error(err);
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  $("log").textContent += line;
  $("log").scrollTop = $("log").scrollHeight;
}

function safeFilename(s) {
  return String(s || "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "video";
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function formatDuration(s) {
  if (!s || !isFinite(s)) return "—";
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
