// Smoke test for how a failed Helper download is explained (no Helper needed).
//
// The service worker turns yt-dlp's failure text into job.errorTitle /
// job.hint / job.hintAction (lib/download_errors.js). This drives the real
// extension in a scratch Chrome profile and checks that the popup's job row
// shows the explanation with an Options button that opens Options › Downloads,
// and that the same job pushed to a page tab is accepted by the badge script
// (the toast lives in a closed shadow root, so it is only screenshotted:
// scripts/.smoke-out/download_hint_toast.png).
//
//   npm i --no-save puppeteer-core   (once)
//   node scripts/smoke_download_hint.js

const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

let puppeteer;
try {
  puppeteer = require("puppeteer-core");
} catch {
  console.error("puppeteer-core missing: npm i --no-save puppeteer-core");
  process.exit(2);
}

const EXT = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, ".smoke-out");
const CHROME =
  process.env.CHROME ||
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));
const PORT = 18099;
const SITE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What ytdlp_bridge.js's failJob() produces for YouTube's bot check.
const JOB = {
  id: "smoke1",
  url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  page: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  quality: "720",
  title: "Me at the zoo",
  status: "error",
  percent: 0,
  startedAt: Date.now() - 5000,
  finishedAt: Date.now(),
  updated: Date.now(),
  tabId: -1,
  error:
    "yt-dlp exited with code 1. ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.",
  errorShort: "[youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.",
  errorKind: "bot-check",
  errorTitle: "YouTube wants a sign-in check",
  hint: "Turn on “Use my browser’s cookies” in ComboBreaker options › Downloads, then retry. This is YouTube's bot check for your network, not a broken Helper.",
  hintAction: "options-downloads",
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>hint smoke</title><body><h1>page</h1><video src='https://example.com/x.mp4' controls width=300></video></body>");
  });
  await new Promise((r) => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-smoke-hint-")),
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

  try {
    const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 20000 });
    const extId = new URL(swTarget.url()).hostname;
    await sleep(1500);

    const site = await browser.newPage();
    await site.goto(SITE + "/", { waitUntil: "load" });
    await sleep(400);

    // Popup as a tab. Jobs and Helper status come from stubs; the current tab
    // is the local page; open-options is captured instead of opening a tab.
    const pop = await browser.newPage();
    await pop.evaluateOnNewDocument((job, site) => {
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (msg, cb) => {
        const reply = (r) => {
          if (cb) cb({ ok: true, result: r });
          return Promise.resolve({ ok: true, result: r });
        };
        if (msg && msg.type === "ytdlp-jobs") return reply([job]);
        if (msg && msg.type === "ytdlp-status") {
          return reply({ available: true, permission: "ready", ytdlp: { version: "test" }, ffmpeg: { version: "test" }, outputDir: "~/Downloads/combobreaker" });
        }
        if (msg && msg.type === "open-options") {
          window.__opened = msg;
          return reply({});
        }
        return real(msg, cb);
      };
      const realQuery = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q, cb) => {
        const p = realQuery({}).then((tabs) => [tabs.find((x) => x.url && x.url.startsWith(site)) || tabs[0]]);
        if (cb) p.then(cb);
        return p;
      };
    }, JOB, SITE);
    await pop.setViewport({ width: 420, height: 640 });
    await pop.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "load" });
    await sleep(500);
    await pop.click('button.tab[data-tab="media"]');
    await sleep(1200);
    const row = await pop.evaluate(() => {
      const r = document.querySelector(".media-job");
      if (!r) return null;
      const js = r.querySelector(".js");
      return { text: js.textContent, cls: js.className, tooltip: js.title, buttons: [...r.querySelectorAll("button")].map((b) => b.textContent) };
    });
    expect("row-rendered", !!row, row);
    if (row) {
      expect("row-shows-explanation", row.text.startsWith(JOB.errorTitle) && row.text.includes("Use my browser’s cookies") && row.cls.includes("hint"), row.text);
      expect("row-tooltip-raw-error", row.tooltip === JOB.error, row.tooltip);
      expect("row-has-options-and-retry", row.buttons.includes("Options") && row.buttons.includes("Retry"), row.buttons);
      await pop.evaluate(() => {
        const b = [...document.querySelectorAll(".media-job button")].find((x) => x.textContent === "Options");
        if (b) b.click();
      });
      await sleep(200);
      const opened = await pop.evaluate(() => window.__opened);
      expect("options-button-opens-downloads", opened && opened.type === "open-options" && opened.section === "downloads", opened);
    }
    await pop.screenshot({ path: path.join(OUT, "download_hint_popup.png") });

    // Same job to the page: the badge script must accept it (toast shown in a
    // closed shadow root; screenshot only).
    const opts = await browser.newPage();
    await opts.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: "load" });
    const tabId = await opts.evaluate((site) => chrome.tabs.query({ url: site + "/*" }).then((t) => t[0] && t[0].id), SITE);
    const sent = await opts.evaluate(
      (id, job) =>
        chrome.tabs
          .sendMessage(id, { type: "cb-ytdlp-job", job: { ...job, status: "downloading", percent: 10 } })
          .then(() => chrome.tabs.sendMessage(id, { type: "cb-ytdlp-job", job }))
          .catch((e) => ({ error: String(e) })),
      tabId,
      JOB
    );
    expect("page-accepts-job", sent && sent.ok === true, sent);
    await site.bringToFront();
    await sleep(500);
    await site.screenshot({ path: path.join(OUT, "download_hint_toast.png") });
  } catch (e) {
    expect("script", false, String(e.stack || e));
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  for (const [name, r] of Object.entries(results)) {
    console.log(`${r.ok ? "✓" : "✗"} ${name}${r.ok ? "" : " " + JSON.stringify(r.detail)}`);
  }
  if (failures.length) {
    console.error(`\n${failures.length} failed`);
    process.exit(1);
  }
  console.log(`\nall good (screenshots in ${OUT})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
