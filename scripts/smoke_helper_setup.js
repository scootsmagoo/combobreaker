// Smoke test for the Helper setup page's permission handling (no Helper needed).
//
// Drives the unpacked extension in a scratch Chrome profile and checks:
//   1. with nativeMessaging not granted, the setup page shows only the Allow
//      step (no terminal steps that could not help);
//   2. ytdlp-status reports permission "needs-permission";
//   3. overlay-list-all on an extension page returns [] instead of throwing;
//   4. the reload-and-reopen dance the bridge does after a grant: with the
//      reopen marker set, chrome.runtime.reload() brings the setup page back
//      at the same window/index, the marker is consumed, and a second reload
//      opens nothing.
//
// The grant itself (the Allow click) opens a native prompt automation cannot
// press, so the "needs-reload" branch is covered by test/helper.test.mjs.
//
// Requires developer mode in the scratch profile: since Chrome 137 an
// unpacked extension is disabled on reload otherwise
// (disableReasons.unsupportedDeveloperExtension). The script turns it on
// through chrome://extensions.
//
//   npm i --no-save puppeteer-core   (once)
//   node scripts/smoke_helper_setup.js

const path = require("path");
const fs = require("fs");
const os = require("os");

let puppeteer;
try {
  puppeteer = require("puppeteer-core");
} catch {
  console.error("puppeteer-core missing: npm i --no-save puppeteer-core");
  process.exit(2);
}

const EXT = path.resolve(__dirname, "..");
const CHROME =
  process.env.CHROME ||
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));
const SETUP = "/viewer/helper_setup.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-smoke-helper-")),
    pipe: true,
    enableExtensions: [EXT],
    args: ["--no-first-run", "--no-default-browser-check", "--window-size=1000,800"],
  });
  const results = {};
  const failures = [];
  const expect = (name, ok, detail) => {
    results[name] = { ok: !!ok, detail };
    if (!ok) failures.push(name);
  };
  const pageState = (p) =>
    p.evaluate(() => ({
      title: document.getElementById("status-title").textContent,
      allow: !document.getElementById("allow").hidden,
      posix: !document.getElementById("steps-posix").hidden,
      win: !document.getElementById("steps-win").hidden,
      restart: !document.getElementById("restart").hidden,
      done: !document.getElementById("done").hidden,
    }));
  const placeOf = (p) => p.evaluate(() => new Promise((r) => chrome.tabs.getCurrent((t) => r({ windowId: t.windowId, index: t.index }))));

  try {
    const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 20000 });
    const extId = new URL(swTarget.url()).hostname;
    await sleep(1500);

    const ext = await browser.newPage();
    await ext.goto("chrome://extensions", { waitUntil: "load" });
    await ext.evaluate(() => new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r)));
    const extInfo = () =>
      ext.evaluate(
        (id) => new Promise((r) => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, (l) => r(l.find((e) => e.id === id)))),
        extId
      );

    // 1. no grant: Allow only
    const setup = await browser.newPage();
    await setup.goto(`chrome-extension://${extId}${SETUP}`, { waitUntil: "load" });
    await sleep(1200);
    const s1 = await pageState(setup);
    expect("allow-only", s1.allow && !s1.posix && !s1.win && !s1.restart && !s1.done && /permission/i.test(s1.title), s1);

    // 2. status shape
    const st = (await setup.evaluate(() => chrome.runtime.sendMessage({ type: "ytdlp-status", force: true }))).result;
    expect("status-needs-permission", st && st.permission === "needs-permission" && st.needsPermission === true && st.available === false, st);

    // 3. overlay list on an extension tab
    const tabId = await setup.evaluate(() => new Promise((r) => chrome.tabs.getCurrent((t) => r(t.id))));
    const ov = await setup.evaluate((id) => chrome.runtime.sendMessage({ type: "overlay-list-all", tabId: id }), tabId);
    expect("overlay-ext-tab-empty", ov && ov.ok && Array.isArray(ov.result) && ov.result.length === 0, ov);

    // 4. reload + reopen at the same place
    await setup.evaluate(() => new Promise((r) => chrome.tabs.getCurrent((t) => chrome.tabs.move(t.id, { index: 1 }, r))));
    const place = await placeOf(setup);
    await setup.evaluate((p) => chrome.storage.local.set({ cb_helper_setup_reopen: p, cb_helper_reload_at: Date.now() }), place);
    setup.evaluate(() => chrome.runtime.reload()).catch(() => {});
    let found = null;
    for (let i = 0; i < 12 && !found; i++) {
      await sleep(1000);
      found = browser.targets().find((t) => t.type() === "page" && t.url().endsWith(SETUP));
    }
    const info = await extInfo();
    expect("still-enabled-after-reload", info && info.state === "ENABLED", info && { state: info.state, reasons: info.disableReasons });
    expect("reopened", !!found);
    if (found) {
      const p = await found.page();
      await sleep(1200);
      const where = await placeOf(p);
      expect("reopened-same-place", where.windowId === place.windowId && where.index === place.index, { place, where });
      const left = await p.evaluate(() => chrome.storage.local.get(["cb_helper_setup_reopen"]));
      expect("marker-consumed", !left.cb_helper_setup_reopen, left);
      const s2 = await pageState(p);
      expect("reopened-allow-only", s2.allow && !s2.posix && !s2.restart, s2);
      await p.evaluate(() => chrome.runtime.reload()).catch(() => {});
      await sleep(4000);
      const n = browser.targets().filter((t) => t.url().endsWith(SETUP)).length;
      expect("no-reopen-without-marker", n === 0, { setupTabs: n });
    }
  } catch (e) {
    expect("script", false, String(e.stack || e));
  } finally {
    await browser.close().catch(() => {});
  }

  for (const [name, r] of Object.entries(results)) {
    console.log(`${r.ok ? "✓" : "✗"} ${name}${r.ok ? "" : " " + JSON.stringify(r.detail)}`);
  }
  if (failures.length) {
    console.error(`\n${failures.length} failed`);
    process.exit(1);
  }
  console.log("\nall good");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
