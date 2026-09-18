// Smoke test for the on-page download badge (content/media_overlay.js).
//
// Loads the unpacked extension into a throwaway Chrome profile, then:
//   - serves a local page with two <video>s (one under a pointer-events:none
//     overlay) and checks the badge, the popup's item list and "locate";
//   - opens the popup and options pages and records console errors;
//   - hovers a YouTube search-result thumbnail, opens the badge menu, clicks
//     the main button (copy fallback when the bridge isn't installed), then
//     does the same on the watch-page player.
// Screenshots and results.json land next to this script.
//
//   npm i --no-save puppeteer-core     (anywhere on NODE_PATH / next to this file)
//   node scripts/smoke_overlay.js
//
// Chrome 137+ no longer honours --load-extension for the branded build, so
// this uses puppeteer's pipe + enableExtensions path. Set CHROME to override
// the browser binary.
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
const OUT = path.join(__dirname, ".smoke-out");
fs.mkdirSync(OUT, { recursive: true });

const PAGE = `<!doctype html><html><head><title>Smoke test page</title>
<style>body{margin:0;background:#222;color:#eee;font-family:sans-serif} .wrap{padding:40px} video{width:480px;height:270px;background:#000;display:block}
.overlay{position:relative;width:480px} .overlay .cover{position:absolute;inset:0;background:transparent} .overlay video{pointer-events:none}</style></head>
<body><div class="wrap"><h1>Generic video</h1>
<video id="v1" src="/media/sample.mp4" poster="/media/poster.png" controls></video>
<h1>Overlay-covered blob-ish video</h1>
<div class="overlay"><video id="v2" src="/media/second.webm"></video><div class="cover"></div></div>
<p>done</p></div></body></html>`;

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    } else if (req.url.startsWith("/media/")) {
      res.writeHead(200, { "content-type": req.url.endsWith(".webm") ? "video/webm" : "video/mp4" });
      res.end(Buffer.alloc(16));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(18081, r));

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-smoke-"));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir,
    pipe: true,
    enableExtensions: [EXT],
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "--mute-audio",
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  const results = {};
  try {
    let swTarget;
    try {
      swTarget = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 20000 });
    } catch (e) {
      console.log("targets:", browser.targets().map((t) => t.type() + " " + t.url()));
      throw e;
    }
    const sw = await swTarget.worker();
    results.extId = new URL(swTarget.url()).hostname;
    console.log("extension id", results.extId);

    // ---- generic page ----
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("http://127.0.0.1:18081/", { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 800));

    // hover the first video
    const v1 = await page.$("#v1");
    const b1 = await v1.boundingBox();
    await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2, { steps: 5 });
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: path.join(OUT, "generic_hover.png") });
    const hostPresent = await page.evaluate(() => !!document.querySelector("cb-media-overlay"));
    results.genericHostPresent = hostPresent;

    // hover the overlay-covered video
    const v2 = await page.$("#v2");
    const b2 = await v2.boundingBox();
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2, { steps: 5 });
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: path.join(OUT, "generic_hover2.png") });

    // ask the content script for its item list through the SW (like the popup does)
    const tabIdInfo = await sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({ url });
      const tab = tabs[0];
      const items = await chrome.tabs.sendMessage(tab.id, { type: "cb-overlay-list" }, { frameId: 0 });
      const st = await chrome.tabs.sendMessage(tab.id, { type: "cb-overlay-state" }, { frameId: 0 });
      return { tabId: tab.id, items, st };
    }, "http://127.0.0.1:18081/");
    results.genericItems = tabIdInfo.items;
    results.overlayState = tabIdInfo.st;

    // bridge status from SW

    // locate
    results.locate = await sw.evaluate(async (tabId, id) => {
      return await chrome.tabs.sendMessage(tabId, { type: "cb-overlay-locate", id }, { frameId: 0 });
    }, tabIdInfo.tabId, tabIdInfo.items.items[0].id);
    await new Promise((r) => setTimeout(r, 700));
    await page.screenshot({ path: path.join(OUT, "generic_locate.png") });

    // click the badge's download button: move to top-right of v1, then click there
    await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2, { steps: 3 });
    await new Promise((r) => setTimeout(r, 300));
    // badge sits 8px inside the top-right corner; its width ~90px, height ~28px
    await page.mouse.move(b1.x + b1.width - 8 - 60, b1.y + 8 + 14, { steps: 3 });
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: path.join(OUT, "generic_badge_hover.png") });
    results.genericErrors = errors;

    // ---- popup page loads without errors ----
    const popup = await browser.newPage();
    const perr = [];
    popup.on("console", (m) => {
      if (m.type() === "error") perr.push(m.text());
    });
    popup.on("pageerror", (e) => perr.push(String(e)));
    await popup.goto(`chrome-extension://${results.extId}/popup/popup.html`, { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 500));
    await popup.click('.tab[data-tab="media"]');
    await new Promise((r) => setTimeout(r, 1200));
    await popup.screenshot({ path: path.join(OUT, "popup_media.png") });
    results.popupErrors = perr;

    // ---- options page ----
    const opts = await browser.newPage();
    const oerr = [];
    opts.on("console", (m) => {
      if (m.type() === "error") oerr.push(m.text());
    });
    opts.on("pageerror", (e) => oerr.push(String(e)));
    await opts.goto(`chrome-extension://${results.extId}/options/options.html#downloads`, { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 1500));
    await opts.screenshot({ path: path.join(OUT, "options_downloads.png") });
    results.optionsErrors = oerr;
    results.optionsBridgeText = await opts.$eval("#bridge-text", (e) => e.textContent);

    // ---- YouTube search results (thumbnails) ----
    const yt = await browser.newPage();
    const yerr = [];
    yt.on("pageerror", (e) => yerr.push(String(e)));
    await yt.goto("https://www.youtube.com/results?search_query=lofi+hip+hop", { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 7000));
    try {
      const btn = await yt.$('button[aria-label*="Accept"], button[aria-label*="Reject"]');
      if (btn) await btn.click();
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    const thumbs = await yt.$$('a[href*="watch?v="]');
    let hovered = null;
    for (const a of thumbs) {
      const hasImg = await a.$("img, yt-image");
      const bb = await a.boundingBox();
      if (hasImg && bb && bb.width > 150 && bb.height > 80 && bb.y > 60 && bb.y < 700) {
        hovered = { a, bb, href: await a.evaluate((e) => e.getAttribute("href")) };
        break;
      }
    }
    results.ytThumbCount = thumbs.length;
    if (hovered) {
      results.ytHovered = hovered.href;
      await yt.mouse.move(hovered.bb.x + hovered.bb.width / 2, hovered.bb.y + hovered.bb.height / 2, { steps: 8 });
      await new Promise((r) => setTimeout(r, 700));
      await yt.screenshot({ path: path.join(OUT, "youtube_hover.png") });
      // caret at far right of the badge
      const cx = hovered.bb.x + hovered.bb.width - 8 - 10;
      const cy = hovered.bb.y + 8 + 14;
      await yt.mouse.move(cx, cy, { steps: 4 });
      await new Promise((r) => setTimeout(r, 200));
      await yt.mouse.click(cx, cy);
      await new Promise((r) => setTimeout(r, 500));
      await yt.screenshot({ path: path.join(OUT, "youtube_menu.png") });
      results.ytUrlAfterCaret = yt.url();
      await yt.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 300));
      // main download button (copy fallback since no bridge)
      await yt.mouse.move(hovered.bb.x + hovered.bb.width / 2, hovered.bb.y + hovered.bb.height / 2, { steps: 4 });
      await new Promise((r) => setTimeout(r, 400));
      const dx = hovered.bb.x + hovered.bb.width - 8 - 55;
      await yt.mouse.move(dx, cy, { steps: 4 });
      await new Promise((r) => setTimeout(r, 200));
      await yt.mouse.click(dx, cy);
      await new Promise((r) => setTimeout(r, 900));
      await yt.screenshot({ path: path.join(OUT, "youtube_click.png") });
      results.ytUrlAfterClick = yt.url();
    } else {
      results.ytNote = "no thumbnail found in viewport";
      await yt.screenshot({ path: path.join(OUT, "youtube_nothumb.png") });
    }
    results.ytItems = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
      const tab = tabs[0];
      const r = await chrome.tabs.sendMessage(tab.id, { type: "cb-overlay-list" }, { frameId: 0 });
      return { count: r.items.length, first: r.items.slice(0, 2) };
    });
    results.ytErrors = yerr.slice(0, 5);

    // ---- YouTube watch page (player) ----
    if (hovered) {
      const watchUrl = new URL(hovered.href, "https://www.youtube.com/").href;
      await yt.goto(watchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await new Promise((r) => setTimeout(r, 8000));
      const player = await yt.$(".html5-video-player");
      const pb = player ? await player.boundingBox() : null;
      results.watchPlayerBox = pb;
      if (pb) {
        await yt.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 8 });
        await new Promise((r) => setTimeout(r, 700));
        await yt.screenshot({ path: path.join(OUT, "youtube_watch_hover.png") });
        const cx = pb.x + pb.width - 8 - 10;
        const cy = Math.max(8 + 14, pb.y + 8 + 14);
        await yt.mouse.move(cx, cy, { steps: 4 });
        await new Promise((r) => setTimeout(r, 200));
        await yt.mouse.click(cx, cy);
        await new Promise((r) => setTimeout(r, 500));
        await yt.screenshot({ path: path.join(OUT, "youtube_watch_menu.png") });
      }
      results.watchItems = await sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" });
        const tab = tabs[0];
        const r = await chrome.tabs.sendMessage(tab.id, { type: "cb-overlay-list" }, { frameId: 0 });
        return { count: r.items.length, first: r.items.slice(0, 2) };
      });
    }
  } catch (e) {
    results.fatal = String(e && e.stack || e);
  } finally {
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
    await browser.close().catch(() => {});
    server.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
