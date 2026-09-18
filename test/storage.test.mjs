import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome } from "./fake_chrome.mjs";

const chrome = installFakeChrome();
const {
  getSite,
  setSite,
  listSites,
  deleteSite,
  ensureSchema,
  getGlobal,
  setGlobal,
  effectiveDarkModeFor,
} = await import("../lib/storage.js");

function reset(sync = {}, local = {}) {
  chrome.storage.sync._reset(sync);
  chrome.storage.local._reset(local);
}

test("css/js bodies go to storage.local, the rest to sync", async () => {
  reset();
  const big = "x".repeat(50_000); // far beyond the 8 KB per-item cap of storage.sync
  await setSite("example.com", { css: big, cssEnabled: true, darkMode: "on" });
  const sync = chrome.storage.sync._dump();
  const local = chrome.storage.local._dump();
  assert.equal("css" in sync["site:example.com"], false);
  assert.equal("js" in sync["site:example.com"], false);
  assert.equal(sync["site:example.com"].cssEnabled, true);
  assert.equal(local["sitecode:example.com"].css, big);
  const back = await getSite("example.com");
  assert.equal(back.css, big);
  assert.equal(back.darkMode, "on");
});

test("an emptied site is removed from both areas", async () => {
  reset();
  await setSite("a.com", { js: "1", jsEnabled: true });
  await setSite("a.com", { js: "", jsEnabled: false });
  assert.deepEqual(chrome.storage.sync._dump(), {});
  assert.deepEqual(chrome.storage.local._dump(), {});
});

test("listSites merges and deleteSite clears both", async () => {
  reset();
  await setSite("b.com", { css: "b{}", cssEnabled: true });
  await setSite("a.com", { darkMode: "off" });
  const sites = await listSites();
  assert.deepEqual(
    sites.map((s) => s.siteKey),
    ["a.com", "b.com"]
  );
  assert.equal(sites[1].settings.css, "b{}");
  await deleteSite("b.com");
  assert.equal((await listSites()).length, 1);
  assert.equal("sitecode:b.com" in chrome.storage.local._dump(), false);
});

test("v3 to v4 migration moves code out of sync and keeps it readable", async () => {
  reset({
    schema_version: 3,
    global: { adblockEnabled: false },
    "site:old.com": {
      css: "p{}",
      cssEnabled: true,
      js: "",
      jsEnabled: false,
      darkMode: null,
      requestHeaders: [],
      responseHeaders: [],
    },
  });
  await ensureSchema();
  const sync = chrome.storage.sync._dump();
  assert.equal(sync.schema_version, 4);
  assert.equal("css" in sync["site:old.com"], false);
  assert.equal(chrome.storage.local._dump()["sitecode:old.com"].css, "p{}");
  assert.equal((await getSite("old.com")).css, "p{}");
  assert.equal((await getGlobal()).adblockEnabled, false);
  await ensureSchema(); // idempotent
  assert.equal((await getSite("old.com")).cssEnabled, true);
});

test("v1 to v4 migration converts boolean darkMode", async () => {
  reset({
    global: { defaultDarkMode: true },
    "site:x.com": { darkMode: false },
    "site:y.com": { darkMode: null },
  });
  await ensureSchema();
  assert.equal((await getGlobal()).darkMode.enabled, true);
  assert.equal((await getSite("x.com")).darkMode, "off");
  assert.equal("site:y.com" in chrome.storage.sync._dump(), false);
});

test("setGlobal deep-merges darkMode.theme and ytdlp", async () => {
  reset();
  await setGlobal({ darkMode: { theme: { sepia: 20 } } });
  await setGlobal({ ytdlp: { quality: "720" } });
  const g = await getGlobal();
  assert.equal(g.darkMode.theme.sepia, 20);
  assert.equal(g.darkMode.theme.brightness, 100);
  assert.equal(g.ytdlp.quality, "720");
  assert.equal(g.ytdlp.preferMp4, true);
});

test("effectiveDarkModeFor: site override beats global", () => {
  const on = { darkMode: { enabled: true } };
  assert.equal(effectiveDarkModeFor(on, { darkMode: "off" }), false);
  assert.equal(effectiveDarkModeFor({ darkMode: { enabled: false } }, { darkMode: "on" }), true);
  assert.equal(effectiveDarkModeFor(on, { darkMode: null }), true);
});

test("adblockLevel: derived from the old boolean, and keeps adblockEnabled in step", async () => {
  reset({ global: { adblockEnabled: false } });
  let g = await getGlobal();
  assert.equal(g.adblockLevel, "off");
  assert.equal(g.adblockEnabled, false);

  reset({ global: { adblockEnabled: true } });
  assert.equal((await getGlobal()).adblockLevel, "basic");

  reset();
  assert.equal((await getGlobal()).adblockLevel, "basic");
  g = await setGlobal({ adblockLevel: "strong" });
  assert.equal(g.adblockLevel, "strong");
  assert.equal(g.adblockEnabled, true);
  g = await setGlobal({ adblockLevel: "nonsense" });
  assert.equal(g.adblockLevel, "basic");
});

test("adblockLevel: legacy setGlobal({adblockEnabled}) callers still work", async () => {
  reset();
  await setGlobal({ adblockLevel: "strong" });
  assert.equal((await setGlobal({ adblockEnabled: false })).adblockLevel, "off");
  assert.equal((await setGlobal({ adblockEnabled: true })).adblockLevel, "basic");
});

test("adblockPaused keeps a site entry alive and round-trips", async () => {
  reset();
  await setSite("p.com", { adblockPaused: true });
  assert.equal((await getSite("p.com")).adblockPaused, true);
  await setSite("p.com", { adblockPaused: false });
  assert.deepEqual(chrome.storage.sync._dump(), {});
});
