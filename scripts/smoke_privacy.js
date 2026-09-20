// Smoke test for the redirect tracer, the blocked-request counter and the per-site privacy
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
  if (url.pathname === "/custom") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><title>custom</title><img src="http://tracker.test:${PORT}/pixel?n=c${url.searchParams.get("n")}">`);
  }
  if (url.pathname === "/ads") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(
      `<!doctype html><title>ads</title><script src="https://doubleclick.net/x.js"></script>` +
        `<script src="https://www.doubleclick.net/y.js"></script><img src="https://google-analytics.com/collect">`
    );
  }
  if (url.pathname === "/hop1" || url.pathname === "/hop2") {
    res.writeHead(url.pathname === "/hop1" ? 302 : 301, { location: url.pathname === "/hop1" ? "/hop2" : "/blank" });
    return res.end();
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
    // tracker.test: a named third party for the personal blocklist (it takes host names, not IPs).
    args: ["--no-first-run", "--no-default-browser-check", "--window-size=1000,700", "--host-resolver-rules=MAP tracker.test 127.0.0.1"],
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

    // Redirect tracer: every hop of one navigation stays in the chain.
    const hop = await browser.newPage();
    await hop.goto(`${SITE}/hop1`, { waitUntil: "load" });
    await sleep(500);
    const chain = await opts.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return (await chrome.runtime.sendMessage({ type: "get-redirect-chain", tabId: tab.id })).result;
    }, `${SITE}/blank`);
    expect(
      "redirectChain",
      chain.map((e) => e.type).join(",") === "start,redirect,redirect,end" && chain[0].url.endsWith("/hop1") && chain[1].status === 302,
      chain.map((e) => [e.type, e.url || e.to, e.status])
    );
    await hop.close();

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

    // Personal blocklist: junk is dropped, the host is blocked, Off lifts it.
    const load = async (n) => {
      const p = await browser.newPage();
      await p.goto(`${SITE}/custom?n=${n}`, { waitUntil: "networkidle0" });
      await sleep(300);
      const tabId = await opts.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${SITE}/custom*`);
      const matched = (await opts.evaluate((id) => chrome.runtime.sendMessage({ type: "adblock-matched", tabId: id }), tabId)).result;
      await p.close();
      return { reached: !!pixels[`c${n}`], custom: matched && matched.custom };
    };
    const before = await load(1);
    const saved = await opts.evaluate(() => chrome.runtime.sendMessage({ type: "custom-block-set", hosts: "https://Tracker.test/x\nnot a host\n10.0.0.1\nsub.tracker.test" }));
    const during = await load(2);
    await opts.evaluate(() => chrome.runtime.sendMessage({ type: "set-global", patch: { adblockLevel: "off" } }));
    await opts.evaluate(() => chrome.runtime.sendMessage({ type: "apply-adblock" }));
    const whenOff = await load(3);
    await opts.evaluate(() => chrome.runtime.sendMessage({ type: "set-global", patch: { adblockLevel: "basic" } }));
    await opts.evaluate(() => chrome.runtime.sendMessage({ type: "apply-adblock" }));
    const own = await opts.evaluate(() => chrome.runtime.sendMessage({ type: "custom-block-add", host: "cdn.other.test" }));
    await opts.evaluate(() => chrome.runtime.sendMessage({ type: "custom-block-set", hosts: [] }));
    const cleared = await load(4);
    expect(
      "customBlocklist",
      before.reached &&
        JSON.stringify(saved.result.hosts) === '["tracker.test"]' &&
        !during.reached &&
        during.custom === 1 &&
        whenOff.reached &&
        own.ok &&
        own.result.hosts.includes("cdn.other.test") &&
        cleared.reached,
      { before, saved: saved.result, during, whenOff, own: own.result, cleared }
    );

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
