import test from "node:test";
import assert from "node:assert/strict";
import { classifyByUrl, classifyByMime, isStreamSegment, safeFilename, filenameFromUrl, filenameForItem, DIRECT_KINDS } from "../lib/media.js";

test("classifyByUrl", () => {
  assert.equal(classifyByUrl("https://x.test/v/master.m3u8?token=1"), "hls");
  assert.equal(classifyByUrl("https://x.test/v/manifest.mpd#t=1"), "dash");
  assert.equal(classifyByUrl("https://x.test/clip.M4V"), "mp4");
  assert.equal(classifyByUrl("https://x.test/clip.ogv"), "ogg");
  assert.equal(classifyByUrl("https://x.test/song.aac"), "aac");
  assert.equal(classifyByUrl("https://x.test/page.html"), null);
  assert.equal(classifyByUrl("https://x.test/mp4/about"), null);
  assert.equal(classifyByUrl(""), null);
  assert.equal(classifyByUrl(null), null);
});

test("classifyByMime: manifests, parameters, vendor subtypes", () => {
  assert.equal(classifyByMime("application/vnd.apple.mpegurl"), "hls");
  assert.equal(classifyByMime("Application/X-MPEGURL; charset=utf-8"), "hls");
  assert.equal(classifyByMime("audio/mpegurl"), "hls");
  assert.equal(classifyByMime("application/dash+xml"), "dash");
  assert.equal(classifyByMime("video/mp4; codecs=avc1"), "mp4");
  assert.equal(classifyByMime("audio/mp4"), "m4a");
  assert.equal(classifyByMime("audio/mpeg"), "mp3");
  assert.equal(classifyByMime("video/mpeg"), "mpeg");
  assert.equal(classifyByMime("video/quicktime"), "mov");
  assert.equal(classifyByMime("video/x-matroska"), "mkv");
  assert.equal(classifyByMime("audio/x-m4a"), "m4a");
  assert.equal(classifyByMime("audio/x-wav"), "wav");
  assert.equal(classifyByMime("audio/webm"), "webm");
  assert.equal(classifyByMime("video/"), "video");
  assert.equal(classifyByMime("text/html"), null);
  assert.equal(classifyByMime("application/json"), null);
  assert.equal(classifyByMime(""), null);
});

test("every common direct-file MIME type lands on a direct-download kind", () => {
  for (const mime of ["video/mp4", "video/webm", "video/quicktime", "video/x-matroska", "video/ogg", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/aac", "video/x-flv"]) {
    assert.ok(DIRECT_KINDS.has(classifyByMime(mime)), mime);
  }
  for (const mime of ["application/vnd.apple.mpegurl", "application/dash+xml"]) assert.ok(!DIRECT_KINDS.has(classifyByMime(mime)), mime);
});

test("isStreamSegment: segments are dropped, real files are kept", () => {
  for (const [url, mime] of [
    ["https://cdn.test/v/seg-00012.ts", "video/mp2t"],
    ["https://cdn.test/v/0012", "video/MP2T"],
    ["https://cdn.test/v/chunk-stream0-00012.m4s", "video/mp4"],
    ["https://cdn.test/v/seg_12.mp4?sig=abc", "video/mp4"],
    ["https://cdn.test/v/audio/segment12.m4a", "audio/mp4"],
    ["https://cdn.test/v/frag-3.mp4", "video/mp4"],
    ["https://cdn.test/v/init-stream0.mp4", "video/mp4"],
    ["https://cdn.test/v/x.cmfv", "video/mp4"],
    ["https://cdn.test/v/x", "video/iso.segment"],
  ]) {
    assert.equal(isStreamSegment(url, mime), true, url);
  }
  for (const [url, mime] of [
    ["https://cdn.test/videos/holiday.mp4", "video/mp4"],
    ["https://cdn.test/videos/segment-of-my-life.mp4", "video/mp4"],
    ["https://cdn.test/videos/initiation.mp4", "video/mp4"],
    ["https://cdn.test/v/master.m3u8", "application/vnd.apple.mpegurl"],
    ["https://cdn.test/podcast/ep12.mp3", "audio/mpeg"],
    ["https://cdn.test/chunk12/movie.webm", "video/webm"],
    ["not a url", ""],
  ]) {
    assert.equal(isStreamSegment(url, mime), false, url);
  }
});

test("safeFilename strips what Windows and macOS refuse", () => {
  assert.equal(safeFilename('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(safeFilename("  lots   of\n space  "), "lots of space");
  assert.equal(safeFilename("x".repeat(300)).length, 120);
  assert.equal(safeFilename(null), "");
});

test("filenameFromUrl keeps media names, rebuilds the rest", () => {
  assert.equal(filenameFromUrl("https://x.test/a/My%20Clip.mp4?sig=1"), "My Clip.mp4");
  assert.equal(filenameFromUrl("https://x.test/get.php?file=clip.mp4", "Holiday"), "Holiday.mp4");
  assert.equal(filenameFromUrl("https://x.test/stream/12345", "Holiday"), "Holiday.bin");
  assert.equal(filenameFromUrl("https://x.test/stream/12345"), "x.test.bin");
  assert.equal(filenameFromUrl("https://x.test/a/%E0%A4%A.mp4"), "%E0%A4%A.mp4"); // malformed escape survives
  assert.equal(filenameFromUrl("nonsense", "T"), "T");
});

test("filenameForItem: title, tweet id, resolution, fallbacks", () => {
  assert.equal(filenameForItem({ title: "Cat video", page: "https://x.com/u/status/1234567890" }, { url: "https://video.twimg.com/a/1280x720/v.mp4", kind: "mp4", res: "720p" }), "Cat video [1234567890].mp4");
  assert.equal(filenameForItem({ title: "Talk: part 1/2", page: "https://site.test/watch" }, { url: "https://cdn.test/v.webm", kind: "webm", res: "1080p" }), "Talk_ part 1_2 [1080p].webm");
  assert.equal(filenameForItem({ title: "", page: "https://site.test/watch" }, { url: "https://cdn.test/blob", kind: "video" }), "site.test.mp4");
  assert.equal(filenameForItem({ title: "Song" }, { url: "https://cdn.test/s", kind: "mpeg" }), "Song.mp3");
  assert.equal(filenameForItem({ title: "Y" }, { url: "https://youtube.com/watch?v=1", kind: "ytdlp" }), "youtube.com.mp4");
  assert.equal(filenameForItem(null, { url: "nope", kind: "audio" }), "video.m4a");
});
