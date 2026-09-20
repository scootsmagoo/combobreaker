import test from "node:test";
import assert from "node:assert/strict";
import { parseM3u8, parseAttrList, detectContainer, rangeHeader } from "../lib/hls.js";

const BASE = "https://cdn.example.com/v/abc/master.m3u8?token=1";

test("master playlist: variants, relative URLs, separate audio, i-frame streams ignored", () => {
  const p = parseM3u8(
    `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2149280,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=29.970,AUDIO="aud"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6221600, RESOLUTION=1920x1080
# a comment between the tag and its URI

https://other.example.net/1080p.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,URI="iframes.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1
`,
    BASE
  );
  assert.equal(p.kind, "master");
  assert.equal(p.hasSeparateAudio, true);
  assert.deepEqual(p.variants, [
    { url: "https://cdn.example.com/v/abc/720p/index.m3u8", bandwidth: 2149280, codecs: "avc1.64001f,mp4a.40.2", resolution: "1280x720", frameRate: 29.97 },
    { url: "https://other.example.net/1080p.m3u8", bandwidth: 6221600, codecs: "", resolution: "1920x1080", frameRate: null },
  ]);
});

test("master without audio renditions; subtitles do not count", () => {
  const p = parseM3u8(`#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="subs.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="muxed"\n#EXT-X-STREAM-INF:BANDWIDTH=5\nv.m3u8\n`, BASE);
  assert.equal(p.hasSeparateAudio, false); // an AUDIO entry without URI is muxed into the variants
});

test("plain TS media playlist: CRLF, BOM, durations, endlist", () => {
  const text = "﻿#EXTM3U\r\n#EXT-X-TARGETDURATION:10\r\n#EXTINF:9.009,\r\nseg0.ts\r\n#EXTINF:9.5,title\r\n  seg1.ts?x=1  \r\n#EXTINF:bogus,\r\nseg2.ts\r\n#EXT-X-ENDLIST\r\n";
  const p = parseM3u8(text, BASE);
  assert.equal(p.kind, "media");
  assert.deepEqual(
    p.segments.map((s) => [s.url, s.duration, s.range]),
    [
      ["https://cdn.example.com/v/abc/seg0.ts", 9.009, null],
      ["https://cdn.example.com/v/abc/seg1.ts?x=1", 9.5, null],
      ["https://cdn.example.com/v/abc/seg2.ts", null, null],
    ]
  );
  assert.ok(Math.abs(p.totalDuration - 18.509) < 1e-9);
  assert.equal(p.endlist, true);
  assert.equal(p.encryption, null);
  assert.equal(p.initSegmentUrl, null);
  assert.equal(detectContainer(p), "ts");
});

test("live playlist has no endlist", () => {
  assert.equal(parseM3u8("#EXTM3U\n#EXTINF:4,\na.ts\n", BASE).endlist, false);
});

test("fMP4 with byte ranges: explicit and implicit offsets, per resource", () => {
  const p = parseM3u8(
    `#EXTM3U
#EXT-X-MAP:URI="main.mp4",BYTERANGE="719@0"
#EXTINF:6,
#EXT-X-BYTERANGE:1000@719
main.mp4
#EXTINF:6,
#EXT-X-BYTERANGE:500
main.mp4
#EXTINF:6,
#EXT-X-BYTERANGE:200
other.mp4
#EXTINF:6,
#EXT-X-BYTERANGE:300
main.mp4
#EXTINF:6,
whole.mp4
#EXT-X-ENDLIST
`,
    BASE
  );
  assert.deepEqual(p.initSegment, { url: "https://cdn.example.com/v/abc/main.mp4", range: { offset: 0, length: 719 } });
  assert.deepEqual(
    p.segments.map((s) => s.range),
    [{ offset: 719, length: 1000 }, { offset: 1719, length: 500 }, { offset: 0, length: 200 }, { offset: 2219, length: 300 }, null]
  );
  assert.equal(detectContainer(p), "fmp4");
  assert.equal(rangeHeader(p.segments[0].range), "bytes=719-1718");
  assert.equal(rangeHeader(p.initSegment.range), "bytes=0-718");
  assert.equal(rangeHeader(null), null);
  assert.equal(rangeHeader({ offset: 5, length: 0 }), null);
});

test("encryption is sticky: a later METHOD=NONE does not clear it", () => {
  const p = parseM3u8(
    `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k1",IV=0x00000000000000000000000000000001
#EXTINF:4,
a.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:4,
ad.ts
`,
    BASE
  );
  assert.deepEqual(p.encryption, { method: "AES-128", uri: "https://keys.example.com/k1", iv: "0x00000000000000000000000000000001" });
  assert.equal(parseM3u8("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.ts\n", BASE).encryption, null);
});

test("several EXT-X-MAP tags: first wins, count is reported", () => {
  const p = parseM3u8(`#EXTM3U\n#EXT-X-MAP:URI="init-a.mp4"\n#EXTINF:2,\na1.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init-b.mp4"\n#EXTINF:2,\nb1.m4s\n`, BASE);
  assert.equal(p.initSegmentUrl, "https://cdn.example.com/v/abc/init-a.mp4");
  assert.equal(p.initSegment.range, null);
  assert.equal(p.mapCount, 2);
});

test("detectContainer goes by the path, not the query string", () => {
  const seg = (url) => ({ segments: [{ url }], initSegmentUrl: null });
  assert.equal(detectContainer(seg("https://x.test/a/seg1.m4s?sig=a.ts")), "fmp4");
  assert.equal(detectContainer(seg("https://x.test/a/seg1.aac")), "aac");
  assert.equal(detectContainer(seg("https://x.test/a/seg1?format=.mp4")), "ts");
  assert.equal(detectContainer({ segments: [], initSegmentUrl: null }), "ts");
});

test("parseAttrList: quoted commas, spaces, hex and resolution values", () => {
  assert.deepEqual(parseAttrList('CODECS="avc1.4d401e,mp4a.40.2", RESOLUTION=640x360 ,IV=0xABCD,NAME="a=b"'), {
    CODECS: '"avc1.4d401e,mp4a.40.2"',
    RESOLUTION: "640x360",
    IV: "0xABCD",
    NAME: '"a=b"',
  });
});

test("garbage in does not throw", () => {
  assert.deepEqual(parseM3u8("", BASE).segments, []);
  assert.deepEqual(parseM3u8(null, BASE).segments, []);
  assert.equal(parseM3u8("<html>404</html>", "not a url").segments.length, 1); // caller sees a junk "segment", not a crash
});
