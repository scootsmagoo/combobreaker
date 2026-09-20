// HLS (.m3u8) playlist parsing for viewer/hls_downloader.js. Pure: text in,
// plain objects out, so node:test can feed it real-world playlists.
//
// parseM3u8(text, baseUrl) returns one of
//   { kind: "master", variants: Variant[], hasSeparateAudio }
//   { kind: "media", segments: Segment[], totalDuration, endlist,
//     encryption, initSegment, initSegmentUrl, mapCount }
// Variant = { url, bandwidth, codecs, resolution, frameRate }
// Segment = { url, duration, range }      range = { offset, length } | null
// initSegment = { url, range } | null

export function parseM3u8(text, baseUrl) {
  const raw = String(text || "");
  // Some servers prepend a UTF-8 byte-order mark.
  const lines = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    .split(/\r?\n/)
    .map((l) => l.trim());
  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  const variants = [];
  let hasSeparateAudio = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseAttrList(line.slice("#EXT-X-MEDIA:".length));
      if ((attrs["TYPE"] || "").toUpperCase() === "AUDIO" && attrs["URI"]) hasSeparateAudio = true;
      continue;
    }
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = parseAttrList(line.slice("#EXT-X-STREAM-INF:".length));
    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next || next.startsWith("#")) continue;
      url = resolveUrl(next, baseUrl);
      break;
    }
    if (!url) continue;
    variants.push({
      url,
      bandwidth: parseInt(attrs["BANDWIDTH"] || "0", 10) || null,
      codecs: stripQuotes(attrs["CODECS"] || ""),
      resolution: attrs["RESOLUTION"] || "",
      frameRate: attrs["FRAME-RATE"] ? Number(attrs["FRAME-RATE"]) : null,
    });
  }
  return { kind: "master", variants, hasSeparateAudio };
}

// "<length>[@<offset>]". Without an offset the range starts where the
// previous range of the same resource ended (RFC 8216 §4.3.2.2).
function parseByteRange(value, prevEnd) {
  const m = /^(\d+)(?:@(\d+))?$/.exec(stripQuotes(String(value || "").trim()));
  if (!m) return null;
  const length = Number(m[1]);
  const offset = m[2] != null ? Number(m[2]) : prevEnd;
  return { offset, length };
}

function parseMedia(lines, baseUrl) {
  const segments = [];
  let totalDuration = 0;
  let pendingDuration = null;
  let pendingRange = null; // raw attribute text until the URL is known
  let endlist = false;
  let encryption = null;
  let initSegment = null;
  let mapCount = 0;
  const rangeEnd = new Map(); // url -> end of the last range read from it

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const num = parseFloat(line.slice("#EXTINF:".length));
      pendingDuration = isNaN(num) ? null : num;
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = line.slice("#EXT-X-BYTERANGE:".length);
      continue;
    }
    if (line.startsWith("#EXT-X-ENDLIST")) {
      endlist = true;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      // Sticky: a later METHOD=NONE (unencrypted ad break, say) does not make
      // the earlier segments readable.
      const attrs = parseAttrList(line.slice("#EXT-X-KEY:".length));
      const method = stripQuotes(attrs["METHOD"] || "");
      if (method && method !== "NONE" && !encryption) {
        encryption = { method, uri: stripQuotes(attrs["URI"] || ""), iv: attrs["IV"] || "" };
      }
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttrList(line.slice("#EXT-X-MAP:".length));
      const uri = stripQuotes(attrs["URI"] || "");
      if (uri) {
        mapCount += 1;
        // Only the first one is used; a second map means a mid-stream format
        // change that plain concatenation cannot express.
        if (!initSegment) {
          const url = resolveUrl(uri, baseUrl);
          initSegment = { url, range: attrs["BYTERANGE"] ? parseByteRange(attrs["BYTERANGE"], 0) : null };
        }
      }
      continue;
    }
    if (line.startsWith("#")) continue;

    const url = resolveUrl(line, baseUrl);
    let range = null;
    if (pendingRange != null) {
      range = parseByteRange(pendingRange, rangeEnd.get(url) || 0);
      if (range) rangeEnd.set(url, range.offset + range.length);
    }
    segments.push({ url, duration: pendingDuration, range });
    if (pendingDuration) totalDuration += pendingDuration;
    pendingDuration = null;
    pendingRange = null;
  }

  return {
    kind: "media",
    segments,
    totalDuration,
    endlist,
    encryption,
    initSegment,
    initSegmentUrl: initSegment ? initSegment.url : null,
    mapCount,
  };
}

export function parseAttrList(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]+)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].trim();
  return out;
}

export function stripQuotes(s) {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

export function resolveUrl(ref, base) {
  try {
    return new URL(ref, base).href;
  } catch {
    return ref;
  }
}

// "fmp4" | "aac" | "ts" for a parsed media playlist.
export function detectContainer(parsed) {
  if (parsed.initSegmentUrl) return "fmp4";
  const first = parsed.segments[0];
  if (!first) return "ts";
  let path = first.url;
  try {
    path = new URL(first.url).pathname;
  } catch {
    // keep the raw string
  }
  const ext = ((path.match(/\.([a-z0-9]+)$/i) || [])[1] || "").toLowerCase();
  if (ext === "m4s" || ext === "mp4" || ext === "m4v" || ext === "cmfv") return "fmp4";
  if (ext === "aac") return "aac";
  return "ts";
}

// HTTP Range header value for a segment's byte range, or null.
export function rangeHeader(range) {
  if (!range || !(range.length > 0)) return null;
  return `bytes=${range.offset}-${range.offset + range.length - 1}`;
}
