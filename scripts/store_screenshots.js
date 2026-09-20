// Generates the five 1280×800 Chrome Web Store screenshots into docs/store/,
// from a staged demo site, so they can be regenerated after any UI change.
//
//   npm i --no-save puppeteer-core
//   node scripts/store_screenshots.js
//
// The toolbar popup cannot be captured as a real popup, so popup.html is
// rendered in a tab (pointed at the demo tab) and composited over a capture
// of the page.
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
const OUT = path.join(EXT, "docs", "store");
const CHROME =
  process.env.CHROME ||
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));
const PORT = 18090;
const SITE = `http://localhost:${PORT}`;
const W = 1280;
const H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STORIES = [
  ["City council approves riverside cycle path after two-year debate", "Local", 48],
  ["Small bakery wins national award for its sourdough", "Food", 112],
  ["Library extends opening hours through the winter", "Community", 17],
  ["Commuter rail line to add early-morning services", "Transport", 63],
  ["Students build weather station from recycled parts", "Schools", 29],
  ["Harbour festival returns with record number of boats", "Events", 85],
];
const DEMO = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The Daily Example — Local news</title>
<meta name="description" content="Independent local news from the Example valley: council, transport, schools, food and events, updated through the day.">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="${SITE}/">
<meta property="og:title" content="The Daily Example"><meta property="og:description" content="Independent local news."><meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsMediaOrganization","name":"The Daily Example","url":"${SITE}/"}</script>
<style>
 body{margin:0;font:16px/1.5 Georgia,serif;color:#1c1c1c;background:#fbfaf7}
 header{border-bottom:3px double #1c1c1c;padding:18px 0 12px;text-align:center}
 header h1{margin:0;font-size:40px;letter-spacing:1px} header p{margin:2px 0 0;font:12px/1 Arial,sans-serif;letter-spacing:2px;text-transform:uppercase;color:#666}
 nav{font:13px Arial,sans-serif;text-align:center;padding:8px;border-bottom:1px solid #ddd} nav a{margin:0 12px;color:#333;text-decoration:none}
 main{max-width:1040px;margin:22px auto;display:grid;grid-template-columns:2fr 1fr;gap:34px}
 article{padding:0 0 14px;margin:0 0 14px;border-bottom:1px solid #e2dfd8} h2{margin:0 0 2px;font-size:21px;line-height:1.25} h2 a{color:#1c1c1c;text-decoration:none}
 .meta{font:12px Arial,sans-serif;color:#777} .meta a{color:#777}
 aside{font:13px Arial,sans-serif} .ad{background:#ececec;border:1px solid #d5d5d5;height:250px;display:flex;align-items:center;justify-content:center;color:#999;margin-bottom:18px}
 aside h3{font-size:12px;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid #1c1c1c;padding-bottom:4px}
</style></head><body>
<header><h1>The Daily Example</h1><p>Independent local news</p></header>
<nav><a href="/s/local">Local</a><a href="/s/transport">Transport</a><a href="/s/schools">Schools</a><a href="/s/food">Food</a><a href="/s/events">Events</a></nav>
<main><section id="stories">${STORIES.map(([t, sec, n], i) => `<article><h2><a href="/story/${i + 1}">${t}</a></h2><div class="meta">${sec} · <a href="/story/${i + 1}#comments">${n} comments</a> · <a href="/share/${i + 1}">share</a></div></article>`).join("")}</section>
<aside><div class="ad"><img src="https://ad.doubleclick.net/banner.png" width="300" height="250" alt="">Advertisement</div><h3>Most read</h3><p><a href="/story/2">Small bakery wins national award</a></p><p><a href="/story/6">Harbour festival returns</a></p>
<img src="https://www.facebook.com/tr?id=1" width="1" height="1" alt=""><img src="http://127.0.0.1:${PORT}/px.gif" width="1" height="1" alt=""></aside></main>
<script src="https://www.google-analytics.com/analytics.js"></script><script src="https://static.hotjar.com/c/hotjar.js"></script>
<script>fetch("https://bat.bing.com/action").catch(()=>{});
localStorage.setItem("reader_prefs",JSON.stringify({fontSize:18,theme:"paper",sections:["local","food"]}));localStorage.setItem("last_visit","2026-09-20T09:14:00Z");localStorage.setItem("newsletter_dismissed","true");document.cookie="session=demo123; path=/";</script>
</body></html>`;

function serve(req, res) {
  if (req.url.startsWith("/shot/")) {
    const file = path.join(os.tmpdir(), "cb-store-" + path.basename(req.url));
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(fs.readFileSync(file));
  }
  if (req.url.startsWith("/stage")) {
    const q = new URL(req.url, SITE).searchParams;
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;background:url(/shot/${q.get("bg")}) top left/${W}px auto no-repeat">
      <div style="position:absolute;top:0;left:0;right:0;height:${H}px;background:rgba(10,14,25,.18)"></div>
      <img src="/shot/${q.get("fg")}" style="position:absolute;top:14px;right:40px;width:400px;border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08)"></body>`);
  }
  res.writeHead(200, { "content-type": req.url.endsWith(".gif") ? "image/gif" : "text/html" });
  res.end(req.url.endsWith(".gif") ? "" : DEMO);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = http.createServer(serve);
  await new Promise((r) => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-store-")),
    pipe: true,
    enableExtensions: [EXT],
    defaultViewport: { width: W, height: H },
    args: ["--no-first-run", "--no-default-browser-check", `--window-size=${W},${H + 90}`],
  });
  const tmp = (name) => path.join(os.tmpdir(), "cb-store-" + name);

  try {
    const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 20000 });
    const extId = new URL(swTarget.url()).hostname;
    await sleep(1500);
    const opts = await browser.newPage();
    await opts.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: "load" });
    const send = (msg) => opts.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    await send({ type: "set-site", siteKey: "localhost", patch: { css: "header h1 { letter-spacing: 2px; }", cssEnabled: true, blockThirdPartyCookies: true, autoClear: true } });
    await send({ type: "apply-site-headers", siteKey: "localhost" });
    await send({ type: "set-global", patch: { adblockLevel: "strong" } });
    await send({ type: "apply-adblock" });

    const demo = await browser.newPage();
    await demo.goto(SITE + "/", { waitUntil: "networkidle0" });
    await sleep(800);
    await demo.screenshot({ path: tmp("page.png") });

    // The popup, rendered in a tab that believes the demo tab is the active one.
    const popupShot = async (name, prepare) => {
      const p = await browser.newPage();
      await p.setViewport({ width: 400, height: 600, deviceScaleFactor: 2 });
      await p.evaluateOnNewDocument((site) => {
        const q = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (f) => (f && f.active ? q({ url: site + "/" }) : q(f));
      }, SITE);
      await p.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "load" });
      await sleep(1200);
      if (prepare) await prepare(p);
      await p.screenshot({ path: tmp(name) });
      await p.close();
    };
    const compose = async (fg, out) => {
      const stage = await browser.newPage();
      await stage.goto(`${SITE}/stage?bg=page.png&fg=${fg}`, { waitUntil: "networkidle0" });
      await sleep(300);
      await stage.screenshot({ path: path.join(OUT, out), clip: { x: 0, y: 0, width: W, height: H } });
      await stage.close();
    };

    // 1. Popup, Site tab.
    await popupShot("popup-site.png");
    await compose("popup-site.png", "1-popup-site.png");

    // 4. Popup, Cookies → Local storage.
    await popupShot("popup-storage.png", async (p) => {
      await p.click('.tab[data-tab="cookies"]');
      await p.click('#storage-kind [data-kind="local"]');
      await sleep(700);
      await p.evaluate(() => document.querySelector("#storage-list .value")?.click());
      await sleep(200);
    });
    await compose("popup-storage.png", "4-storage-viewer.png");

    // 2. Tracker highlighter.
    await demo.bringToFront();
    await opts.evaluate(async (site) => {
      const [tab] = await chrome.tabs.query({ url: site + "/" });
      await chrome.runtime.sendMessage({ type: "launch-tool", tool: "trackers", tabId: tab.id });
    }, SITE);
    await demo.bringToFront();
    await sleep(1200);
    await demo.screenshot({ path: path.join(OUT, "2-tracker-highlighter.png") });
    await demo.keyboard.press("Escape");

    // 3. Link select, mid-drag over the first four stories.
    const box = await demo.$eval("#stories", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width };
    });
    await demo.keyboard.down("z");
    await demo.mouse.move(box.x - 14, box.y - 8);
    await demo.mouse.down();
    await demo.mouse.move(box.x + 300, box.y + 150, { steps: 6 });
    await demo.mouse.move(box.x + box.w - 40, box.y + 292, { steps: 6 });
    await sleep(300);
    await demo.screenshot({ path: path.join(OUT, "3-link-select.png") });
    await demo.keyboard.press("Escape");
    await demo.mouse.up();
    await demo.keyboard.up("z");

    // 5. SEO & structured data viewer.
    await opts.evaluate(async (site) => {
      const [tab] = await chrome.tabs.query({ url: site + "/" });
      await chrome.runtime.sendMessage({ type: "structured-data-open", tabId: tab.id });
    }, SITE);
    const viewerTarget = await browser.waitForTarget((t) => t.url().includes("structured_data.html"), { timeout: 10000 });
    const viewer = await viewerTarget.page();
    await viewer.setViewport({ width: W, height: H });
    await sleep(900);
    await viewer.evaluate(() => document.querySelectorAll("#meta-section details").forEach((d, i) => (d.open = i === 0)));
    await viewer.screenshot({ path: path.join(OUT, "5-seo-viewer.png") });
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
  for (const f of fs.readdirSync(OUT).sort()) console.log(`docs/store/${f}  ${Math.round(fs.statSync(path.join(OUT, f)).size / 1024)} KB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
