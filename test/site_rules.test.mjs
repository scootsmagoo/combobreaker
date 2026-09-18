import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSiteRules,
  siteNeedsRules,
  sanitizeHeaderRules,
  normalizeReferrerPolicy,
  SITE_RULE_PRIORITY,
} from "../lib/site_rules.js";

test("sanitizeHeaderRules drops junk and empty values", () => {
  assert.deepEqual(
    sanitizeHeaderRules([
      { name: " X-Debug ", op: "set", value: "1" },
      { name: "", op: "set", value: "x" },
      { name: "X-Empty", op: "set", value: "" },
      { name: "Cookie", op: "remove", value: "ignored" },
      { name: "X-Op", op: "bogus", value: "v" },
      null,
    ]),
    [
      { name: "X-Debug", op: "set", value: "1" },
      { name: "Cookie", op: "remove", value: "" },
      { name: "X-Op", op: "set", value: "v" },
    ]
  );
  assert.deepEqual(sanitizeHeaderRules("nope"), []);
});

test("nothing configured means no rules", () => {
  const empty = { requestHeaders: [], responseHeaders: [], blockThirdPartyCookies: false, referrerPolicy: "" };
  assert.equal(siteNeedsRules(empty), false);
  assert.deepEqual(buildSiteRules("example.com", empty), []);
  assert.deepEqual(buildSiteRules("file://", { blockThirdPartyCookies: true }), []);
  assert.deepEqual(buildSiteRules(null, { blockThirdPartyCookies: true }), []);
});

test("header overrides target requests going to the site", () => {
  const rules = buildSiteRules("example.com", {
    requestHeaders: [{ name: "X-Debug", op: "set", value: "1" }],
    responseHeaders: [{ name: "X-Frame-Options", op: "remove" }],
  });
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].condition.requestDomains, ["example.com"]);
  assert.deepEqual(rules[0].action.requestHeaders, [{ header: "X-Debug", operation: "set", value: "1" }]);
  assert.deepEqual(rules[1].action.responseHeaders, [{ header: "X-Frame-Options", operation: "remove" }]);
  for (const r of rules) assert.equal(r.priority, SITE_RULE_PRIORITY);
});

test("third-party cookie rule spares navigations and first-party requests", () => {
  const [rule] = buildSiteRules("example.com", { blockThirdPartyCookies: true });
  assert.deepEqual(rule.condition.initiatorDomains, ["example.com"]);
  assert.equal(rule.condition.domainType, "thirdParty");
  assert.ok(!rule.condition.resourceTypes.includes("main_frame"));
  assert.ok(rule.condition.resourceTypes.includes("sub_frame"));
  assert.deepEqual(rule.action.requestHeaders, [{ header: "cookie", operation: "remove" }]);
  assert.deepEqual(rule.action.responseHeaders, [{ header: "set-cookie", operation: "remove" }]);
});

test("referrer policies", () => {
  assert.equal(normalizeReferrerPolicy("unsafe-url"), "");
  assert.equal(siteNeedsRules({ referrerPolicy: "unsafe-url" }), false);

  const originOnly = buildSiteRules("example.com", { referrerPolicy: "strict-origin-when-cross-origin" });
  assert.equal(originOnly.length, 1);
  assert.deepEqual(originOnly[0].condition.resourceTypes, ["main_frame", "sub_frame"]);
  assert.equal(originOnly[0].action.responseHeaders[0].value, "strict-origin-when-cross-origin");

  const sameOrigin = buildSiteRules("example.com", { referrerPolicy: "same-origin" });
  assert.equal(sameOrigin.length, 2);
  assert.equal(sameOrigin[1].condition.domainType, "thirdParty");
  assert.ok(sameOrigin[1].condition.resourceTypes.includes("main_frame"));

  const never = buildSiteRules("example.com", { referrerPolicy: "no-referrer" });
  assert.equal(never.length, 2);
  assert.equal(never[1].condition.domainType, undefined);
  assert.deepEqual(never[1].action.requestHeaders, [{ header: "referer", operation: "remove" }]);
});
