import test from "node:test";
import assert from "node:assert/strict";
import { TECH, detectTech, probeInputs } from "../lib/tech.js";

const names = (signals) => detectTech(signals).map((t) => t.name);

test("signature table is well formed", () => {
  const seen = new Set();
  for (const t of TECH) {
    assert.ok(t.name && t.cat, JSON.stringify(t));
    assert.ok(!seen.has(t.name), `duplicate ${t.name}`);
    seen.add(t.name);
    assert.ok(t.globals || t.selectors || t.scripts || t.generator || t.headers || t.flag, `${t.name} has no signature`);
    for (const re of [...(t.scripts || []), t.generator, ...Object.values(t.headers || {})].filter(Boolean)) {
      assert.ok(re instanceof RegExp, `${t.name}: not a RegExp`);
      assert.ok(!re.global, `${t.name}: /g regexes are stateful under .test()`);
    }
  }
});

test("probeInputs covers every global and selector once", () => {
  const { globals, selectors } = probeInputs();
  assert.ok(globals.includes("Shopify.shop"));
  assert.ok(selectors.includes("#__next"));
  assert.equal(new Set(globals).size, globals.length);
});

test("nothing in, nothing out", () => {
  assert.deepEqual(detectTech(null), []);
  assert.deepEqual(detectTech({}), []);
});

test("detects by global, selector, url, generator, header and flag", () => {
  assert.deepEqual(names({ globals: ["jQuery"], versions: { jquery: "3.7.1" } }), ["jQuery"]);
  assert.equal(detectTech({ globals: ["jQuery"], versions: { jquery: "3.7.1" } })[0].version, "3.7.1");
  assert.deepEqual(names({ selectors: ["#__next"] }), ["Next.js"]);
  assert.deepEqual(names({ urls: ["https://example.com/wp-content/themes/x/style.css"] }), ["WordPress"]);
  assert.deepEqual(names({ generator: "Hugo 0.128.0" }), ["Hugo"]);
  assert.deepEqual(names({ headers: { server: "cloudflare", "cf-ray": "abc" } }), ["Cloudflare"]);
  assert.deepEqual(names({ flags: { react: true } }), ["React"]);
});

test("a typical Next.js-on-Vercel page", () => {
  const got = names({
    globals: ["__NEXT_DATA__", "gtag"],
    selectors: ["#__next"],
    flags: { react: true, tailwind: true },
    urls: ["https://site.example/_next/static/chunks/main.js", "https://www.googletagmanager.com/gtag/js?id=G-1"],
    headers: { server: "Vercel", "x-vercel-id": "iad1::abc" },
  });
  assert.deepEqual(got, ["React", "Next.js", "Tailwind CSS", "Google Analytics", "Vercel"]);
});
