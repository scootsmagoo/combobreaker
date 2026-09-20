// Smoke test for the built-in HLS downloader (viewer/hls_downloader.html):
// a plain TS playlist, and an fMP4 byte-range playlist against a server that
// honours Range and one that ignores it. chrome.downloads.download is stubbed
// in the page so the assembled file can be compared byte for byte.
//
//   npm i --no-save puppeteer-core
//   node scripts/smoke_hls.js
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
let puppeteer;
try {
  puppeteer = require("puppeteer-core");
} catch {
  console.error("puppeteer-core not found. Run: npm i --no-save puppeteer-core");
  process.exit(1);
}

const EXT = path.resolve(__dirname, "..");
const CHROME =
  process.env.CHROME ||
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));
const PORT = 18085;
const SITE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILE = Buffer.from(Array.from({ length: 60 }, (_, i) => 65 + (i % 26))); // ABC…
const RANGE_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="main.mp4",BYTERANGE="10@0"
#EXTINF:6,
#EXT-X-BYTERANGE:20@10
main.mp4
#EXTINF:6,
#EXT-X-BYTERANGE:20
main.mp4
#EXT-X-ENDLIST
`;
const TS_PLAYLIST = "#EXTM3U\n#EXTINF:4,\nts/a.ts\n#EXTINF:4,\nts/b.ts\n#EXT-X-ENDLIST\n";

let honourRange = true;
function serve(req, res) {
  const url = new URL(req.url, SITE);
  if (url.pathname === "/range.m3u8" || url.pathname === "/plain.m3u8") {
    res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    return res.end(url.pathname === "/range.m3u8" ? RANGE_PLAYLIST : TS_PLAYLIST);
  }
  if (url.pathname.startsWith("/ts/")) {
    res.writeHead(200, { "content-type": "video/mp2t" });
    return res.end(url.pathname === "/ts/a.ts" ? "first-" : "second");
  }
  const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
  if (m && honourRange) {
    res.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${m[1]}-${m[2]}/${FILE.length}` });
    return res.end(FILE.subarray(Number(m[1]), Number(m[2]) + 1));
  }
  res.writeHead(200, { "content-type": "video/mp4" });
  res.end(FILE);
}

async function main() {
  const server = http.createServer(serve);
  await new Promise((r) => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-smoke-hls-")),
    pipe: true,
    enableExtensions: [EXT],
    args: ["--no-first-run", "--no-default-browser-check", "--window-size=1000,700"],
  });

  const results = {};
  const failures = [];
  const expect = (name, ok, detail) => {
    results[name] = { ok: !!ok, detail };
    if (!ok) failures.push(name);
  };

  try {
    const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 20000 });
    const extId = new URL(swTarget.url()).hostname;
    await sleep(1500);

    const download = async (playlist) => {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.evaluateOnNewDocument(() => {
        window.__saved = null;
        const wait = setInterval(() => {
          if (!(window.chrome && chrome.downloads)) return;
          clearInterval(wait);
          chrome.downloads.download = async (o) => {
            window.__saved = { text: await (await fetch(o.url)).text(), filename: o.filename };
            return 1;
          };
        }, 5);
      });
      await page.goto(`chrome-extension://${extId}/viewer/hls_downloader.html?url=${encodeURIComponent(SITE + playlist)}&title=clip`, { waitUntil: "load" });
      await page.waitForFunction(() => !document.getElementById("start-btn").disabled, { timeout: 10000 });
      await page.click("#start-btn");
      await page.waitForFunction(() => window.__saved, { timeout: 10000 }).catch(() => {});
      const saved = await page.evaluate(() => window.__saved);
      await page.close();
      return { saved, errors };
    };

    const plain = await download("/plain.m3u8");
    expect("plainTs", plain.saved && plain.saved.text === "first-second" && plain.saved.filename === "combobreaker/clip.ts" && !plain.errors.length, plain);

    const want = FILE.subarray(0, 50).toString();
    honourRange = true;
    const ranged = await download("/range.m3u8");
    expect("byteRanges", ranged.saved && ranged.saved.text === want && ranged.saved.filename === "combobreaker/clip.mp4" && !ranged.errors.length, ranged);
    honourRange = false;
    const ignored = await download("/range.m3u8");
    expect("byteRangesServerIgnoresRange", ignored.saved && ignored.saved.text === want && !ignored.errors.length, ignored);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  console.log(JSON.stringify(results, null, 2));
  if (failures.length) {
    console.error("FAILED:", failures.join(", "));
    process.exit(1);
  }
  console.log("hls smoke ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
