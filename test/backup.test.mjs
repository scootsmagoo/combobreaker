import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome } from "./fake_chrome.mjs";

const chrome = installFakeChrome();
const { exportAll, importAll, normalizeBackup } = await import("../lib/backup.js");
const { setSite, getSite } = await import("../lib/storage.js");
const { matchesForSite, wrapUserCode } = await import("../background/user_scripts.js");

test("normalizeBackup rejects foreign or newer files", () => {
  assert.throws(() => normalizeBackup({}), /Not a ComboBreaker/);
  assert.throws(() => normalizeBackup(null), /Not a ComboBreaker/);
  assert.throws(() => normalizeBackup({ app: "combobreaker", format: 99 }), /newer/);
});

test("normalizeBackup drops unknown fields and bad hosts", () => {
  const out = normalizeBackup({
    app: "combobreaker",
    format: 1,
    sites: { "Good.com": { css: "a{}", evil: 1 }, "bad host/../x": { css: "" }, "n.com": null },
    local: { cb_snippets: [{ name: "s" }], other: [1] },
  });
  assert.deepEqual(Object.keys(out.sites), ["good.com"]);
  assert.deepEqual(out.sites["good.com"], { css: "a{}" });
  assert.deepEqual(Object.keys(out.local), ["cb_snippets"]);
});

test("export, wipe, import round-trips", async () => {
  await setSite("rt.com", {
    js: "console.log(1)",
    jsEnabled: true,
    requestHeaders: [{ name: "X-A", op: "set", value: "1" }],
  });
  const dump = JSON.parse(JSON.stringify(await exportAll()));
  chrome.storage.sync._reset();
  chrome.storage.local._reset();
  const res = await importAll(dump);
  assert.deepEqual(res.sites, ["rt.com"]);
  const s = await getSite("rt.com");
  assert.equal(s.js, "console.log(1)");
  assert.equal(s.requestHeaders[0].name, "X-A");
});

test("userScripts helpers", () => {
  assert.deepEqual(matchesForSite("example.com"), ["*://example.com/*", "*://www.example.com/*"]);
  assert.deepEqual(matchesForSite("file://"), ["file:///*"]);
  assert.deepEqual(matchesForSite("127.0.0.1"), ["*://127.0.0.1/*"]);
  assert.deepEqual(matchesForSite("localhost"), ["*://localhost/*"]);
  assert.deepEqual(matchesForSite(null), []);
  assert.doesNotThrow(() => new Function(wrapUserCode("let a = 1;")));
});
