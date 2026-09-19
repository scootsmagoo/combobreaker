import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTrackerIndex, classifyHost, isThirdParty, wouldBlock } from "../lib/trackers.js";

const basic = [{ id: 1, condition: { urlFilter: "||doubleclick.net^" } }, { id: 2, condition: { urlFilter: "/ads.js" } }];
const strong = [{ id: 1000, condition: { requestDomains: ["adnxs.com", "doubleclick.net", "t.example.org"] } }];
const index = buildTrackerIndex(basic, strong);

test("index: basic wins over strong, non-domain filters are skipped", () => {
  assert.equal(index.get("doubleclick.net"), "basic");
  assert.equal(index.get("adnxs.com"), "strong");
  assert.equal(index.size, 3);
});

test("classifyHost walks up subdomains", () => {
  assert.deepEqual(classifyHost("stats.g.doubleclick.net", index), { list: "basic", domain: "doubleclick.net" });
  assert.deepEqual(classifyHost("ADNXS.com.", index), { list: "strong", domain: "adnxs.com" });
  assert.equal(classifyHost("example.org", index), null); // parent of a listed subdomain is not listed
  assert.equal(classifyHost("notdoubleclick.net", index), null);
  assert.equal(classifyHost("", index), null);
});

test("isThirdParty", () => {
  assert.equal(isThirdParty("cdn.example.com", "www.example.com"), false);
  assert.equal(isThirdParty("a.example.com", "b.example.com"), true); // siblings: the known approximation
  assert.equal(isThirdParty("cdn.example.com", "example.com"), false);
  assert.equal(isThirdParty("example.com", "shop.example.com"), false);
  assert.equal(isThirdParty("doubleclick.net", "example.com"), true);
});

test("wouldBlock follows level, pause and Strong's third-party condition", () => {
  const b = { list: "basic" };
  const s = { list: "strong" };
  assert.equal(wouldBlock(b, { level: "basic", paused: false, thirdParty: true }), true);
  assert.equal(wouldBlock(s, { level: "basic", paused: false, thirdParty: true }), false);
  assert.equal(wouldBlock(s, { level: "strong", paused: false, thirdParty: true }), true);
  assert.equal(wouldBlock(s, { level: "strong", paused: false, thirdParty: false }), false);
  assert.equal(wouldBlock(b, { level: "strong", paused: true, thirdParty: true }), false);
  assert.equal(wouldBlock(b, { level: "off", paused: false, thirdParty: true }), false);
  assert.equal(wouldBlock(null, { level: "strong", paused: false, thirdParty: true }), false);
});

test("the shipped rulesets index cleanly", () => {
  const load = (f) => JSON.parse(readFileSync(new URL(`../rules/${f}`, import.meta.url), "utf8"));
  const real = buildTrackerIndex(load("basic_block.json"), load("strong_block.json"));
  assert.ok(real.size > 3000);
  assert.equal(classifyHost("www.google-analytics.com", real).list, "basic");
});
