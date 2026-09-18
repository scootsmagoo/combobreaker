// Smoke test for per-site CSS/JS, the sync/local storage split, the v3→v4
// migration, custom JS delivery (userScripts vs inline fallback) and the
// options page's backup + status UI.
//
//   npm i --no-save puppeteer-core
//   node scripts/smoke_site.js
//
// Serves two local pages: "/" (no CSP) and "/csp" (script-src 'self', which
// blocks the inline-<script> fallback). On a fresh profile Chrome's "Allow
// User Scripts" switch is off, so /csp is expected to NOT run user JS there;
// the result records which path was taken rather than asserting one.
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
const PORT = 18082;
const HTML = `<!doctype html><html><head><title>site smoke</title></head><body><p id="p">hello</p></body></html>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = http.createServer((req, res) => {
    const headers = { "content-type": "text/html" };
    if (req.url.startsWith("/csp")) headers["content-security-policy"] = "script-src 'self'";
    res.writeHead(req.url === "/" || req.url.startsWith("/csp") ? 200 : 404, headers);
    res.end(HTML);
  });
  await new Promise((r) => server.listen(PORT, r));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-smoke-site-")),
    pipe: true,
    enableExtensions: [EXT],
    args: ["--no-first-run", "--no-default-browser-check", "--window-size=1100,800"],
    defaultViewport: { width: 1100, height: 700 },
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

    // Drive storage through the options page (it imports lib/storage.js).
    const opts = await browser.newPage();
    const optErrors = [];
    opts.on("console", (m) => m.type() === "error" && optErrors.push(m.text()));
    opts.on("pageerror", (e) => optErrors.push(String(e)));
    await opts.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: "load" });
    await sleep(500);

    // 1. Simulate a v3 install with code in sync, then migrate.
    await opts.evaluate(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set({
        schema_version: 3,
        "site:127.0.0.1": {
          css: "#p{color:rgb(1, 2, 3)}",
          cssEnabled: true,
          js: "document.documentElement.dataset.cbUserJs='ran'",
          jsEnabled: true,
          darkMode: null,
          requestHeaders: [],
          responseHeaders: [],
        },
      });
      const { ensureSchema } = await import("../lib/storage.js");
      await ensureSchema();
    });
    const afterMigrate = await opts.evaluate(async () => ({
      sync: await chrome.storage.sync.get(null),
      local: await chrome.storage.local.get(null),
    }));
    expect(
      "migration",
      afterMigrate.sync.schema_version === 4 &&
        !("css" in afterMigrate.sync["site:127.0.0.1"]) &&
        afterMigrate.local["sitecode:127.0.0.1"].css.includes("rgb(1, 2, 3)"),
      Object.keys(afterMigrate.local)
    );

    // 2. A stylesheet far past sync's 8 KB per-item cap must save.
    const bigSave = await opts.evaluate(async () => {
      const { setSite, getSite } = await import("../lib/storage.js");
      const css = "#p{color:rgb(1, 2, 3)}\n" + "/* pad */\n".repeat(6000);
      try {
        await setSite("127.0.0.1", { css });
        return { ok: true, len: (await getSite("127.0.0.1")).css.length };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });
    expect("bigCssSaves", bigSave.ok && bigSave.len > 60000, bigSave);

    // Best effort: flip Chrome's per-extension "Allow User Scripts" switch so
    // the preferred delivery path gets exercised too.
    try {
      const ext = await browser.newPage();
      await ext.goto("chrome://extensions/", { waitUntil: "load" });
      await ext.evaluate(
        (id) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: true }),
        extId
      );
      await ext.close();
      await sleep(500);
    } catch (e) {
      results.userScriptsToggle = String(e.message || e);
    }

    const us = await opts.evaluate(() => chrome.runtime.sendMessage({ type: "userscripts-status" }));
    results.userScripts = us && us.result;
    await sleep(300);

    // 3. Plain page: CSS applied, JS ran exactly once.
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
    await sleep(700);
    const plain = await page.evaluate(() => ({
      color: getComputedStyle(document.getElementById("p")).color,
      js: document.documentElement.dataset.cbUserJs || null,
    }));
    expect("cssApplied", plain.color === "rgb(1, 2, 3)", plain.color);
    expect("jsRan", plain.js === "ran", plain.js);

    // 4. Live disable removes the style without a reload.
    await opts.evaluate(async () => {
      const { setSite } = await import("../lib/storage.js");
      await setSite("127.0.0.1", { cssEnabled: false });
    });
    await sleep(600);
    const afterDisable = await page.evaluate(() => getComputedStyle(document.getElementById("p")).color);
    expect("cssLiveDisable", afterDisable !== "rgb(1, 2, 3)", afterDisable);

    // 5. Strict-CSP page: informational.
    const csp = await browser.newPage();
    await csp.goto(`http://127.0.0.1:${PORT}/csp`, { waitUntil: "load" });
    await sleep(700);
    results.cspPageUserJs = {
      ran: (await csp.evaluate(() => document.documentElement.dataset.cbUserJs || null)) === "ran",
      viaUserScripts: !!(results.userScripts && results.userScripts.available),
    };
    if (results.userScripts && results.userScripts.available) {
      expect("cspJsRanViaUserScripts", results.cspPageUserJs.ran, results.cspPageUserJs);
    }

    // 5b. Snippets runner + site-data nuke, driven like the popup does.
    const tabId = await opts.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `http://127.0.0.1:${PORT}/`);
    const snip = await opts.evaluate(
      (id) => chrome.runtime.sendMessage({ type: "run-snippet", tabId: id, code: "document.documentElement.dataset.cbSnip='ok'" }),
      tabId
    );
    await sleep(300);
    const snipRan = await page.evaluate(() => document.documentElement.dataset.cbSnip || null);
    expect("snippetRan", snip.ok && snipRan === "ok", { snip, snipRan });

    await page.evaluate(() => localStorage.setItem("cb_smoke", "1"));
    const nuke = await opts.evaluate(
      (url) => chrome.runtime.sendMessage({ type: "nuke-site-data", siteKey: "127.0.0.1", tabUrl: url }),
      `http://127.0.0.1:${PORT}/`
    );
    await sleep(500);
    await page.reload({ waitUntil: "load" });
    const lsAfter = await page.evaluate(() => localStorage.getItem("cb_smoke"));
    expect("siteDataNuked", nuke.ok && lsAfter === null, { nuke, lsAfter });

    // 5c. Popup: Snippets section seeds its starters and renders cleanly.
    const popup = await browser.newPage();
    const popupErrors = [];
    popup.on("console", (m) => m.type() === "error" && popupErrors.push(m.text()));
    popup.on("pageerror", (e) => popupErrors.push(String(e)));
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "load" });
    await sleep(500);
    await popup.evaluate(() => {
      document.querySelector('.tab[data-tab="tools"]').click();
      document.querySelector('.util[data-util="snippets"]').open = true;
    });
    await sleep(500);
    const snipNames = await popup.evaluate(() => [...document.querySelectorAll("#snip-list .snip-name")].map((n) => n.textContent));
    expect("popupSnippets", snipNames.length === 3 && popupErrors.length === 0, { snipNames, popupErrors });
    await popup.screenshot({ path: path.join(OUT, "site-popup-snippets.png") });
    await popup.close();

    // 6. Options UI pieces exist and the page stayed error-free.
    await opts.reload({ waitUntil: "load" });
    await sleep(600);
    const ui = await opts.evaluate(() => ({
      exportBtn: !!document.getElementById("backup-export"),
      importBtn: !!document.getElementById("backup-import"),
      usStatus: document.getElementById("us-status").textContent,
      sites: [...document.querySelectorAll("#site-list li")].map((li) => li.textContent),
    }));
    expect("optionsUi", ui.exportBtn && ui.importBtn && ui.usStatus.length > 10 && ui.sites.length === 1, ui);
    const exported = await opts.evaluate(async () => {
      const { exportAll } = await import("../lib/backup.js");
      const d = await exportAll();
      return { app: d.app, sites: Object.keys(d.sites), hasJs: !!d.sites["127.0.0.1"].js };
    });
    expect("export", exported.app === "combobreaker" && exported.hasJs, exported);
    expect("optionsNoErrors", optErrors.length === 0, optErrors);
    await opts.screenshot({ path: path.join(OUT, "site-options.png") });
  } finally {
    fs.writeFileSync(path.join(OUT, "site-results.json"), JSON.stringify(results, null, 2));
    await browser.close().catch(() => {});
    server.close();
  }

  console.log(JSON.stringify(results, null, 2));
  if (failures.length) {
    console.error("FAILED:", failures.join(", "));
    process.exit(1);
  }
  console.log("site smoke ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
