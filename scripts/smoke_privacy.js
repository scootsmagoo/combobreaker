// Smoke test for the blocked-request counter and the per-site privacy
// settings: third-party cookie stripping, referrer override and auto-clear on
// close.
//
//   npm i --no-save puppeteer-core
//   node scripts/smoke_privacy.js
//
// "The site" is http://localhost:18083; the "third party" is the same server
// reached as http://127.0.0.1:18083 (a different site as far as Chrome and
// DNR's domainType are concerned). The server records the Cookie and Referer
// headers each /pixel request arrives with.
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
const PORT = 18083;
const SITE = `http://localhost:${PORT}`;
const THIRD = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pixels = {}; // n -> { cookie, referer }
const pageHits = []; // Cookie header of each "/" request on the site

function serve(req, res) {
  const url = new URL(req.url, SITE);
  if (url.pathname === "/set") {
    // Secure is accepted on loopback http; SameSite=None makes it a real third-party cookie.
    res.writeHead(200, { "content-type": "text/plain", "set-cookie": "tp=1; SameSite=None; Secure; Path=/" });
    return res.end("set");
  }
  if (url.pathname === "/pixel") {
    pixels[url.searchParams.get("n")] = { cookie: req.headers.cookie || "", referer: req.headers.referer || "" };
    res.writeHead(200, { "content-type": "image/gif", "set-cookie": `fromPixel=${url.searchParams.get("n")}; SameSite=None; Secure; Path=/` });
    return res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
  }
  if (url.pathname === "/") {
    pageHits.push(req.headers.cookie || "");
    const n = url.searchParams.get("n") || "0";
    // unsafe-url would normally leak the full address to the third party.
    res.writeHead(200, { "content-type": "text/html", "referrer-policy": "unsafe-url", "set-cookie": "first=1; Path=/" });
    return res.end(`<!doctype html><title>privacy smoke</title><img src="${THIRD}/pixel?n=${n}"><script>localStorage.setItem("k","v")</script>`);
  }
  if (url.pathname === "/ads") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(
      `<!doctype html><title>ads</title><script src="https://doubleclick.net/x.js"></script>` +
        `<script src="https://www.doubleclick.net/y.js"></script><img src="https://google-analytics.com/collect">`
    );
  }
  if (url.pathname === "/blank") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<!doctype html><title>blank</title>");
  }
  res.writeHead(404);
  res.end();
}

async function main() {
  const server = http.createServer(serve);
  await new Promise((r) => server.listen(PORT, r));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-smoke-privacy-")),
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
    const opts = await browser.newPage();
    await opts.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: "load" });
    await sleep(500);
    const setSite = (patch, apply) =>
      opts.evaluate(
        async (patch, apply) => {
          await chrome.runtime.sendMessage({ type: "set-site", siteKey: "localhost", patch });
          return await chrome.runtime.sendMessage({ type: apply, siteKey: "localhost" });
        },
        patch,
        apply
      );
    const visit = async (n) => {
      const page = await browser.newPage();
      await page.goto(`${SITE}/?n=${n}`, { waitUntil: "networkidle0" });
      await sleep(300);
      return page;
    };

    // 0. Blocked-request counter: toolbar badge and the popup's summary.
    const ads = await browser.newPage();
    await ads.goto(`${SITE}/ads`, { waitUntil: "networkidle0" });
    await sleep(500);
    const counted = await opts.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      const matched = await chrome.runtime.sendMessage({ type: "adblock-matched", tabId: tab.id });
      return { matched, badge: await chrome.action.getBadgeText({ tabId: tab.id }) };
    }, `${SITE}/ads`);
    const m = counted.matched.result;
    expect(
      "blockedCounter",
      m && m.total === 3 && m.basic[0].name === "doubleclick.net" && m.basic[0].count === 2 && counted.badge === "3",
      counted
    );
    await ads.close();

    // Give the third party a cookie of its own.
    const tp = await browser.newPage();
    await tp.goto(`${THIRD}/set`, { waitUntil: "load" });
    await tp.close();

    // 1. Baseline: cookie and full referrer reach the third party.
    await (await visit(1)).close();
    expect("baselineLeaks", pixels[1] && pixels[1].cookie.includes("tp=1") && pixels[1].referer.includes("?n=1"), pixels[1]);

    // 2. Third-party cookies blocked, referrer untouched.
    const r2 = await setSite({ blockThirdPartyCookies: true }, "apply-site-headers");
    await (await visit(2)).close();
    expect("cookieStripped", r2.ok && pixels[2] && pixels[2].cookie === "" && pixels[2].referer.includes("?n=2"), { r2, pixel: pixels[2] });
    const tpCookies = await browser.cookies().catch(() => []);
    expect(
      "setCookieStripped",
      !tpCookies.some((c) => c.domain === "127.0.0.1" && c.name === "fromPixel" && c.value === "2"),
      tpCookies.filter((c) => c.domain === "127.0.0.1").map((c) => `${c.name}=${c.value}`)
    );

    // 3. Referrer: origin only, then nothing.
    await setSite({ blockThirdPartyCookies: false, referrerPolicy: "strict-origin-when-cross-origin" }, "apply-site-headers");
    await (await visit(3)).close();
    expect("referrerOriginOnly", pixels[3] && pixels[3].referer === `${SITE}/` && pixels[3].cookie.includes("tp=1"), pixels[3]);
    await setSite({ referrerPolicy: "same-origin" }, "apply-site-headers");
    await (await visit(4)).close();
    expect("referrerHidden", pixels[4] && pixels[4].referer === "", pixels[4]);

    // 4. Auto-clear: data survives while a tab is open, is gone after the last one closes.
    await setSite({ referrerPolicy: "", autoClear: true }, "apply-auto-clear");
    const a = await visit(5);
    const b = await visit(6);
    await a.close();
    await sleep(800);
    const still = await b.evaluate(() => localStorage.getItem("k"));
    expect("keptWhileOpen", still === "v", still);
    await b.close();
    await sleep(1500);
    pageHits.length = 0;
    const c = await browser.newPage();
    await c.goto(`${SITE}/blank`, { waitUntil: "load" }); // same origin, sets nothing
    const after = await c.evaluate(() => ({ ls: localStorage.getItem("k"), cookie: document.cookie }));
    expect("clearedAfterClose", after.ls === null && !after.cookie.includes("first=1"), after);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  console.log(JSON.stringify(results, null, 2));
  if (failures.length) {
    console.error("FAILED:", failures.join(", "));
    process.exit(1);
  }
  console.log("privacy smoke ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
