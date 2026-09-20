// Smoke test for link select (content/link_select.js), with real mouse and
// keyboard input: Z + drag opens headline links in background tabs, S turns
// smart select off, C copies, the right-button trigger works and eats the
// context menu, the box auto-scrolls, and ordinary clicks are left alone.
//
//   npm i --no-save puppeteer-core
//   node scripts/smoke_links.js [screenshot-dir]
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
const PORT = 18086;
const SITE = `http://localhost:${PORT}`;
const SHOTS = process.argv[2] || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Five stories: a headline link plus "comments" (ordinary), one duplicate
// headline, a javascript: link and a same-page anchor in the mix.
const stories = [1, 2, 3, 4, 5]
  .map((n) => `<article><h3><a href="/story/${n}">Story number ${n}</a></h3><p><a href="/story/${n}/comments">${n * 7} comments</a> · <a href="javascript:void(0)">share</a> · <a href="#top">top</a></p></article>`)
  .join("");
const LIST = `<!doctype html><title>links</title><style>body{font:16px sans-serif;margin:20px 40px}article{height:70px}h3{margin:0 0 4px}</style>
<body id="top"><h1>Front page</h1><div id="list">${stories}<article><h3><a href="/story/1">Story number 1 (again)</a></h3></article></div>
<script>window.menus=0;addEventListener("contextmenu",e=>{if(!e.defaultPrevented)window.menus++})</script></body>`;
const LONG = `<!doctype html><title>long</title><style>body{font:16px sans-serif;margin:20px 40px}li{height:60px}</style><ul>${Array.from({ length: 40 }, (_, i) => `<li><a href="/item/${i + 1}">Item ${i + 1}</a></li>`).join("")}</ul>`;

function serve(req, res) {
  res.writeHead(200, { "content-type": "text/html" });
  if (req.url === "/") return res.end(LIST);
  if (req.url === "/long") return res.end(LONG);
  res.end(`<!doctype html><title>${req.url}</title>${req.url}`);
}

async function main() {
  const server = http.createServer(serve);
  await new Promise((r) => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-smoke-links-")),
    pipe: true,
    enableExtensions: [EXT],
    defaultViewport: { width: 1000, height: 700 },
    args: ["--no-first-run", "--no-default-browser-check", "--window-size=1000,800"],
  });
  await browser.defaultBrowserContext().overridePermissions(SITE, ["clipboard-read", "clipboard-write"]);

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
    const setLinkSelect = (patch) => opts.evaluate((p) => chrome.runtime.sendMessage({ type: "set-global", patch: { linkSelect: p } }), patch);

    // Tabs opened from the page, in tab-strip order, then closed again.
    const openedTabs = async (page) => {
      await sleep(900);
      const urls = await opts.evaluate(async (site) => {
        const tabs = await chrome.tabs.query({});
        const mine = tabs.filter((t) => t.url.startsWith(site + "/story/") || t.url.startsWith(site + "/item/"));
        mine.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
        const out = mine.map((t) => ({ url: t.url, active: t.active, windowId: t.windowId }));
        await chrome.tabs.remove(mine.map((t) => t.id));
        return out;
      }, SITE);
      await page.bringToFront();
      return urls;
    };

    const page = await browser.newPage();
    await page.goto(SITE + "/", { waitUntil: "load" });
    await page.bringToFront();
    await sleep(400);
    const listBox = await page.$eval("#list", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    // Box over stories 1–3 (each article is 70px tall).
    const dragOver = async ({ key, button = "left", during }) => {
      if (key) await page.keyboard.down(key);
      await page.mouse.move(listBox.x - 10, listBox.y - 5);
      await page.mouse.down({ button });
      await page.mouse.move(listBox.x + 200, listBox.y + 100, { steps: 6 });
      await page.mouse.move(listBox.x + 420, listBox.y + 205, { steps: 6 });
      await sleep(150);
      if (during) await during();
      await page.mouse.up({ button });
      if (key) await page.keyboard.up(key);
    };

    // 0. Holding Z shows the "armed" crosshair; letting go removes it; a tap never shows it.
    const crosshair = () => page.evaluate(() => getComputedStyle(document.body).cursor === "crosshair");
    await page.keyboard.press("z");
    await sleep(300);
    const afterTap = await crosshair();
    await page.keyboard.down("z");
    await sleep(350);
    const whileHeld = await crosshair();
    await page.keyboard.up("z");
    await sleep(50);
    expect("armedFeedback", !afterTap && whileHeld && !(await crosshair()), { afterTap, whileHeld });

    // The popup's status line asks the tab whether link select is alive there.
    const pong = await opts.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      return await chrome.tabs.sendMessage(tab.id, { type: "cb-link-select-ping" }, { frameId: 0 });
    }, SITE + "/");
    expect("ping", pong && pong.enabled === true && pong.trigger === "z" && pong.action === "tabs", pong);

    // 1. Z + drag, smart select: the three headlines, background tabs, in order.
    await dragOver({
      key: "z",
      during: async () => {
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "link-select.png") });
      },
    });
    const smart = await openedTabs(page);
    expect(
      "smartSelectOpensHeadlines",
      JSON.stringify(smart.map((t) => t.url)) === JSON.stringify([1, 2, 3].map((n) => `${SITE}/story/${n}`)) && smart.every((t) => !t.active) && page.url() === SITE + "/",
      smart
    );

    // 2. S during the drag: everything in the box, cleaned (no javascript:, no #top).
    await dragOver({ key: "z", during: () => page.keyboard.press("s") });
    const all = await openedTabs(page);
    expect(
      "smartOffOpensAll",
      JSON.stringify(all.map((t) => t.url)) === JSON.stringify([1, 2, 3].flatMap((n) => [`${SITE}/story/${n}`, `${SITE}/story/${n}/comments`])),
      all.map((t) => t.url)
    );

    // 3. C during the drag copies instead; W opens a new window.
    await dragOver({ key: "z", during: () => page.keyboard.press("c") });
    await sleep(600);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const noTabs = await openedTabs(page);
    expect("copy", clip === [1, 2, 3].map((n) => `${SITE}/story/${n}`).join("\n") && noTabs.length === 0, { clip, noTabs });

    await setLinkSelect({ copyFormat: "markdown" });
    await dragOver({ key: "z", during: () => page.keyboard.press("c") });
    await sleep(600);
    const md = await page.evaluate(() => navigator.clipboard.readText());
    expect("copyMarkdown", md.startsWith(`- [Story number 1](${SITE}/story/1)\n- [Story number 2]`), md);

    await dragOver({ key: "z", during: () => page.keyboard.press("w") });
    const win = await openedTabs(page);
    const pageWindow = await opts.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].windowId, SITE + "/");
    expect("newWindow", win.length === 3 && win.every((t) => t.windowId !== pageWindow), win);

    // 4. Esc cancels; a drag without the trigger does nothing; a click still navigates.
    await dragOver({ key: "z", during: () => page.keyboard.press("Escape") });
    await dragOver({});
    const none = await openedTabs(page);
    expect("cancelAndUntriggered", none.length === 0, none);
    await page.click('a[href="/story/2"]');
    await sleep(500);
    expect("plainClickStillWorks", page.url() === `${SITE}/story/2`, page.url());
    await page.goto(SITE + "/", { waitUntil: "load" });
    await sleep(300);

    // 4b. Sticky start (keyboard command / popup button): no key held, one plain drag, then back to normal.
    const armTab = () =>
      opts.evaluate(async (u) => {
        const [tab] = await chrome.tabs.query({ url: u });
        return await chrome.tabs.sendMessage(tab.id, { type: "cb-link-select-arm" }, { frameId: 0 });
      }, SITE + "/");
    const armed = await armTab();
    await page.bringToFront();
    await sleep(200);
    const armedCursor = await crosshair();
    await dragOver({});
    const stickyTabs = await openedTabs(page);
    await dragOver({});
    const afterOneShot = await openedTabs(page);
    await armTab();
    await page.bringToFront();
    await page.keyboard.press("Escape");
    await dragOver({});
    const afterEscape = await openedTabs(page);
    expect(
      "stickyStart",
      armed.armed === true && armedCursor && stickyTabs.length === 3 && afterOneShot.length === 0 && afterEscape.length === 0 && !(await crosshair()),
      { armed, armedCursor, sticky: stickyTabs.length, afterOneShot: afterOneShot.length, afterEscape: afterEscape.length }
    );

    // 5. Right-button trigger: opens the links and swallows the context menu;
    //    a right click without a drag still gets its menu event.
    await setLinkSelect({ trigger: "right" });
    await sleep(300);
    await dragOver({ button: "right" });
    const right = await openedTabs(page);
    const menusAfterDrag = await page.evaluate(() => window.menus);
    // macOS / Linux hold the menu back on a first plain right-click; a quick second one gets it.
    await page.mouse.click(600, 40, { button: "right" });
    await sleep(120);
    await page.mouse.click(600, 40, { button: "right" });
    await sleep(200);
    const menusAfterDouble = await page.evaluate(() => window.menus);
    await page.keyboard.press("Escape");
    expect("rightButtonTrigger", right.length === 3 && menusAfterDrag === 0 && menusAfterDouble >= 1, { right: right.map((t) => t.url), menusAfterDrag, menusAfterDouble });

    // 6. Disabled means disabled.
    await setLinkSelect({ trigger: "z", enabled: false });
    await sleep(300);
    await dragOver({ key: "z" });
    const off = await openedTabs(page);
    expect("disabled", off.length === 0, off);
    await setLinkSelect({ enabled: true, copyFormat: "urls" });
    await sleep(300);

    // 7. Auto-scroll: hold the pointer at the bottom edge and the box keeps growing.
    await page.goto(SITE + "/long", { waitUntil: "load" });
    await page.bringToFront();
    await sleep(400);
    await page.keyboard.down("z");
    await page.mouse.move(30, 30);
    await page.mouse.down();
    await page.mouse.move(300, 400, { steps: 5 });
    await page.mouse.move(300, 692, { steps: 5 });
    await sleep(1500);
    const scrolled = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("c");
    await page.mouse.up();
    await page.keyboard.up("z");
    await sleep(600);
    const many = (await page.evaluate(() => navigator.clipboard.readText())).split("\n");
    expect("autoScroll", scrolled > 300 && many.length > 14 && many[0] === `${SITE}/item/1`, { scrolled, copied: many.length });
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  console.log(JSON.stringify(results, null, 2));
  if (failures.length) {
    console.error("FAILED:", failures.join(", "));
    process.exit(1);
  }
  console.log("links smoke ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
