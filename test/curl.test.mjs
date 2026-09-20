import test from "node:test";
import assert from "node:assert/strict";
import { buildCurl, shellQuote } from "../lib/curl.js";

test("shellQuote survives single quotes and shell metacharacters", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(shellQuote("$(rm -rf ~) `x` \"y\""), "'$(rm -rf ~) `x` \"y\"'");
});

test("buildCurl: url, user agent, overrides", () => {
  assert.equal(buildCurl("chrome://extensions"), "");
  assert.equal(buildCurl("https://example.com/a?b=1&c=2"), "curl -sS -i 'https://example.com/a?b=1&c=2'");
  assert.equal(
    buildCurl("https://example.com/", {
      userAgent: "Mozilla/5.0 (X)",
      overrides: [
        { name: "X-Debug", op: "set", value: "it's on" },
        { name: "Accept-Language", op: "remove" },
        { name: "Bad\nName", op: "set", value: "x" },
      ],
    }),
    "curl -sS -i 'https://example.com/' -A 'Mozilla/5.0 (X)' -H 'X-Debug: it'\\''s on' -H 'Accept-Language:'"
  );
});

test("a User-Agent override replaces -A, header values cannot inject lines", () => {
  const cmd = buildCurl("https://example.com/", { userAgent: "real", overrides: [{ name: "User-Agent", op: "set", value: "fake\r\nX-Evil: 1" }] });
  assert.ok(!cmd.includes(" -A "));
  assert.ok(cmd.endsWith("-H 'User-Agent: fake X-Evil: 1'"));
});
