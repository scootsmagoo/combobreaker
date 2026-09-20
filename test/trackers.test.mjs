import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildTrackerIndex,
  classifyHost,
  isThirdParty,
  wouldBlock,
  normalizeBlockHost,
  normalizeBlockList,
  buildCustomBlockRules,
  parseBlocklistText,
  CUSTOM_BLOCK_MAX,
} from "../lib/trackers.js";

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

test("normalizeBlockHost accepts pasted hosts and URLs, rejects junk", () => {
  assert.equal(normalizeBlockHost("  Bat.Bing.com. "), "bat.bing.com");
  assert.equal(normalizeBlockHost("https://ads.example.co.uk:8443/x?y#z"), "ads.example.co.uk");
  assert.equal(normalizeBlockHost("*.tracker.io"), "tracker.io");
  assert.equal(normalizeBlockHost("xn--80ak6aa92e.com"), "xn--80ak6aa92e.com");
  for (const bad of ["", "# comment", "localhost", "exa mple.com", "user@example.com", "-bad.com", "a..b.com", "пример.рф", "http://", "example.c"]) {
    assert.equal(normalizeBlockHost(bad), null, bad);
  }
});

test("normalizeBlockList de-duplicates, sorts and drops covered subdomains", () => {
  assert.deepEqual(normalizeBlockList("b.example.com\nexample.com, zed.net\n\nnot a host\nZED.net\nhttps://a.other.org/p"), [
    "a.other.org",
    "example.com",
    "zed.net",
  ]);
  assert.deepEqual(normalizeBlockList(["x.io", 5, null, "x.io"]), ["x.io"]);
  assert.deepEqual(normalizeBlockList(""), []);
});

test("custom list: rule shape, chunking, index priority, third-party only", () => {
  assert.deepEqual(buildCustomBlockRules(7, []), []);
  const [rule] = buildCustomBlockRules(7, ["x.io"]);
  assert.equal(rule.id, 7);
  assert.deepEqual(rule.condition, { requestDomains: ["x.io"], domainType: "thirdParty" });
  assert.equal(rule.condition.resourceTypes, undefined); // default = everything but main_frame
  const many = buildCustomBlockRules(100, Array.from({ length: 1201 }, (_, i) => `h${i}.example`));
  assert.deepEqual(many.map((r) => [r.id, r.condition.requestDomains.length]), [[100, 500], [101, 500], [102, 201]]);

  const idx = buildTrackerIndex(basic, strong, ["doubleclick.net", "mine.example"]);
  assert.equal(classifyHost("a.doubleclick.net", idx).list, "custom");
  const hit = classifyHost("cdn.mine.example", idx);
  assert.equal(wouldBlock(hit, { level: "basic", paused: false, thirdParty: true }), true);
  assert.equal(wouldBlock(hit, { level: "basic", paused: false, thirdParty: false }), false);
  assert.equal(wouldBlock(hit, { level: "off", paused: false, thirdParty: true }), false);
  assert.equal(wouldBlock(hit, { level: "basic", paused: true, thirdParty: true }), false);
});

test("parseBlocklistText: hosts files, domain lists, simple adblock rules", () => {
  const text = `# Title: some hosts file
! adblock-style comment
[Adblock Plus 2.0]
127.0.0.1 localhost
::1 ip6-localhost
0.0.0.0 0.0.0.0
0.0.0.0 ads.example.com   # inline comment
0.0.0.0 a.tracker.net b.tracker.net
plain-domain.org
||adblock.example^
||third.example^$third-party
||pathy.example/ads/*
@@||allowed.example^
example.com##.banner
/banner/*/img^
*.wild.example
two words`;
  assert.deepEqual(parseBlocklistText(text), ["ads.example.com", "a.tracker.net", "b.tracker.net", "plain-domain.org", "adblock.example", "third.example"]);
  assert.deepEqual(normalizeBlockList(parseBlocklistText(text)), ["a.tracker.net", "adblock.example", "ads.example.com", "b.tracker.net", "plain-domain.org", "third.example"]);
  assert.deepEqual(parseBlocklistText(""), []);
  assert.deepEqual(parseBlocklistText(null), []);
});

test("the blocklist is capped", () => {
  const big = Array.from({ length: CUSTOM_BLOCK_MAX + 50 }, (_, i) => `host${i}.example`);
  assert.equal(normalizeBlockList(big).length, CUSTOM_BLOCK_MAX);
});
