import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSite } from "../lib/site_summary.js";
import { DEFAULT_SITE } from "../lib/storage.js";

const labels = (s, js) => summarizeSite(s, js).map((x) => x.label);

test("an untouched site has nothing to report", () => {
  assert.deepEqual(summarizeSite(DEFAULT_SITE, true), []);
  assert.deepEqual(summarizeSite(null, true), []);
  assert.deepEqual(summarizeSite(undefined), []);
});

test("every per-site setting shows up, in a stable order", () => {
  const got = labels(
    {
      ...DEFAULT_SITE,
      css: "body{}",
      cssEnabled: true,
      js: "1",
      jsEnabled: false,
      darkMode: "off",
      mediaOverlay: false,
      adblockPaused: true,
      requestHeaders: [{ name: "X", op: "set", value: "1" }],
      responseHeaders: [{ name: "Y", op: "remove" }, { name: "Z", op: "remove" }],
      autoClear: true,
      blockThirdPartyCookies: true,
      referrerPolicy: "same-origin",
    },
    false
  );
  assert.deepEqual(got, [
    "JavaScript blocked",
    "ad blocking paused",
    "dark mode off",
    "custom CSS",
    "custom JS (off)",
    "forgotten on close",
    "third-party cookies blocked",
    "referrer hidden from other sites",
    "3 header rules",
    "download badges hidden",
  ]);
});

test("details: whitespace-only code, a single header rule, unknown referrer value", () => {
  assert.deepEqual(labels({ ...DEFAULT_SITE, css: "  \n", cssEnabled: true }, true), []);
  assert.deepEqual(labels({ ...DEFAULT_SITE, requestHeaders: [{}] }, true), ["1 header rule"]);
  assert.deepEqual(labels({ ...DEFAULT_SITE, referrerPolicy: "unsafe-url" }, true), []);
  assert.deepEqual(labels({ ...DEFAULT_SITE, darkMode: "on", mediaOverlay: true }, true), ["dark mode forced on", "download badges forced on"]);
});
