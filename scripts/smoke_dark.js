// Smoke test for dark mode's Auto: bright pages get Dark Reader, pages that
// are dark already are left alone, and On / the global "skip dark sites"
// switch override that.
//
//   npm i --no-save puppeteer-core
//   node scripts/smoke_dark.js
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
const PORT = 18084;
const SITE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = (head, body) => `<!doctype html><html><head><title>dark smoke</title>${head}</head><body>${body}<p>text</p></body></html>`;
const PAGES = {
  "/bright": page("<style>body{background:#fff;color:#111}</style>", ""),
  // Stylesheet arrives late: the early look must wait for it.
  "/dark": page('<link rel="stylesheet" href="/dark.css">', ""),
  // Dark only by declaration, no background of its own.
  "/meta": page('<meta name="color-scheme" content="dark">', ""),
  // Transparent body; a full-page dark app root appears well after DOMContentLoaded.
  "/spa": page(
    "<style>html,body{margin:0}#app{position:fixed;inset:0;background:#0d1117;color:#eee}</style>",
    `<script>setTimeout(()=>{const a=document.createElement("div");a.id="app";a.textContent="app";document.body.appendChild(a)},500)</script>`
  ),
  // No colours declared anywhere, plenty of content: the default white canvas.
  "/plain": page("", "<p>para</p>".repeat(80)),
  // Dark header, bright page: still a bright site.
  "/mixed": page("<style>body{margin:0;background:#fafafa}header{height:60px;background:#111}</style>", "<header></header>"),
};

function serve(req, res) {
  const url = new URL(req.url, SITE);
  if (url.pathname === "/dark.css") {
    return setTimeout(() => {
      res.writeHead(200, { "content-type": "text/css" });
      res.end("body{background:#111;color:#eee}");
    }, 400);
  }
  const html = PAGES[url.pathname];
  res.writeHead(html ? 200 : 404, { "content-type": "text/html" });
  res.end(html || "");
}

async function main() {
  const server = http.createServer(serve);
  await new Promise((r) => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-smoke-dark-")),
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
    const opts = await browser.newPage();
    await opts.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: "load" });
    const send = (msg) => opts.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    const forget = () => opts.evaluate(() => chrome.storage.local.remove("cb_dark_detect"));
    const cached = () => opts.evaluate(async () => ((await chrome.storage.local.get("cb_dark_detect")).cb_dark_detect || {}).localhost);

    // state of a freshly loaded page: is Dark Reader on, is the preamble still there
    const visit = async (pathname, wait = 1200) => {
      const p = await browser.newPage();
      await p.goto(SITE + pathname, { waitUntil: "load" });
      await sleep(wait);
      const state = await p.evaluate(() => ({
        darkReader: document.querySelectorAll("style.darkreader").length > 0,
        preamble: !!document.getElementById("__cb_dark_preamble__"),
      }));
      await p.close();
      return { ...state, cache: await cached() };
    };

    await send({ type: "set-global", patch: { darkMode: { enabled: true } } });

    for (const [pathname, wantDark, wait] of [
      ["/bright", false],
      ["/dark", true],
      ["/meta", true],
      ["/spa", true, 2500],
      ["/mixed", false],
      ["/plain", false, 700], // decided at DOMContentLoaded, not after the 2 s blank-canvas wait
    ]) {
      await forget();
      const s = await visit(pathname, wait);
      // dark page: untouched. bright page: Dark Reader on.
      const ok = wantDark ? !s.darkReader && !s.preamble && s.cache && s.cache.dark === true : s.darkReader && s.cache && s.cache.dark === false;
      expect(`firstVisit${pathname}`, ok, s);
    }

    // Cached verdicts. Cache now says "bright" (from /mixed).
    const fast = await visit("/bright");
    expect("cachedBrightDarkens", fast.darkReader, fast);
    await forget();
    await visit("/dark");
    const again = await visit("/dark");
    expect("cachedDarkLeftAlone", !again.darkReader && !again.preamble, again);
    const turned = await visit("/bright"); // cache says dark, page is bright now
    expect("cachedDarkButBrightNow", turned.darkReader && turned.cache.dark === false, turned);

    // Overrides.
    await forget();
    await send({ type: "set-site", siteKey: "localhost", patch: { darkMode: "on" } });
    const forced = await visit("/dark");
    expect("siteOnForcesDark", forced.darkReader, forced);
    await send({ type: "set-site", siteKey: "localhost", patch: { darkMode: null } });
    await send({ type: "set-global", patch: { darkMode: { detectDark: false } } });
    const noDetect = await visit("/dark");
    expect("detectOffDarkensEverything", noDetect.darkReader, noDetect);
    await send({ type: "set-global", patch: { darkMode: { enabled: false, detectDark: true } } });
    const off = await visit("/bright");
    expect("globalOffDoesNothing", !off.darkReader && !off.preamble, off);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  console.log(JSON.stringify(results, null, 2));
  if (failures.length) {
    console.error("FAILED:", failures.join(", "));
    process.exit(1);
  }
  console.log("dark smoke ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
