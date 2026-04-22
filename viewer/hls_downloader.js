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
    renderVariants(parsed.variants);
  } else {
    await prepareMediaPlaylist(parsed, SOURCE_URL, text);
  }
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
    $("start-btn").disabled = true;
    showFatal(
      "This stream uses fragmented-MP4 segments (.m4s). Concatenation alone " +
        "won't produce a valid file; that needs a real muxer (ffmpeg.wasm). " +
        "Drop the ffmpeg.wasm bundle into vendor/ffmpeg/ to enable that path."
    );
  } else if (STATE.isLive) {
    log("Note: live stream. Only the current window of segments will be captured.");
  }
}

function detectContainer(parsed) {
  if (parsed.initSegmentUrl) return "fmp4";
  const first = parsed.segments[0];
  if (!first) return "ts";
  const ext = (first.url.match(/\.([a-z0-9]+)(?:$|\?|#)/i) || [])[1];
  if (!ext) return "ts";
  const e = ext.toLowerCase();
  if (e === "m4s" || e === "mp4") return "fmp4";
  if (e === "aac") return "aac";
  return "ts";
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

  for (let i = 0; i < total; i++) {
    if (STATE.cancelled) {
      log(`Stopped at segment ${i + 1}/${total}.`);
      $("progress-panel").hidden = true;
      return;
    }
    const seg = segments[i];
    let buf;
    try {
      buf = await fetchBytes(seg.url);
    } catch (e) {
      log(`Segment ${i + 1} failed: ${e.message}. Retrying once…`);
      try {
        buf = await fetchBytes(seg.url);
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

  const filename = $("filename").value || `combobreaker-hls-${Date.now()}.ts`;
  const blob = new Blob(chunks, { type: "video/mp2t" });
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

// ---------- m3u8 parser ----------

function parseM3u8(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
  if (isMaster) return parseMaster(lines, baseUrl);
  return parseMedia(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = parseAttrList(line.slice("#EXT-X-STREAM-INF:".length));
    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next || next.startsWith("#")) continue;
      url = resolveUrl(next, baseUrl);
      break;
    }
    if (!url) continue;
    const res = attrs["RESOLUTION"];
    variants.push({
      url,
      bandwidth: parseInt(attrs["BANDWIDTH"] || "0", 10) || null,
      codecs: stripQuotes(attrs["CODECS"] || ""),
      resolution: res || "",
      frameRate: attrs["FRAME-RATE"] ? Number(attrs["FRAME-RATE"]) : null,
    });
  }
  return { kind: "master", variants };
}

function parseMedia(lines, baseUrl) {
  const segments = [];
  let totalDuration = 0;
  let pendingDuration = null;
  let endlist = false;
  let encryption = null;
  let initSegmentUrl = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const num = parseFloat(line.slice("#EXTINF:".length));
      pendingDuration = isNaN(num) ? null : num;
      continue;
    }
    if (line.startsWith("#EXT-X-ENDLIST")) {
      endlist = true;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttrList(line.slice("#EXT-X-KEY:".length));
      const method = attrs["METHOD"] || "";
      if (method && method !== "NONE") {
        encryption = {
          method,
          uri: stripQuotes(attrs["URI"] || ""),
          iv: attrs["IV"] || "",
        };
      } else {
        encryption = null;
      }
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttrList(line.slice("#EXT-X-MAP:".length));
      const uri = stripQuotes(attrs["URI"] || "");
      if (uri) initSegmentUrl = resolveUrl(uri, baseUrl);
      continue;
    }
    if (line.startsWith("#")) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const url = resolveUrl(trimmed, baseUrl);
    segments.push({ url, duration: pendingDuration });
    if (pendingDuration) totalDuration += pendingDuration;
    pendingDuration = null;
  }

  return {
    kind: "media",
    segments,
    totalDuration,
    endlist,
    encryption,
    initSegmentUrl,
  };
}

function parseAttrList(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]+)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2];
  return out;
}

function stripQuotes(s) {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function resolveUrl(ref, base) {
  try {
    return new URL(ref, base).href;
  } catch {
    return ref;
  }
}

// ---------- Network ----------

async function fetchText(url) {
  const r = await fetch(url, fetchOpts());
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} fetching ${url}`);
  return await r.text();
}

async function fetchBytes(url) {
  const r = await fetch(url, fetchOpts());
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return await r.arrayBuffer();
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
