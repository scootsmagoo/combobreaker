import test from "node:test";
import assert from "node:assert/strict";
import { siteKeyFromUrl, originPatternForSite, urlPatternForSite, hostsForSite } from "../lib/site.js";

test("siteKeyFromUrl strips www and lowercases", () => {
  assert.equal(siteKeyFromUrl("https://WWW.Example.com/a?b=1"), "example.com");
  assert.equal(siteKeyFromUrl("http://news.ycombinator.com:8080/"), "news.ycombinator.com");
});

test("siteKeyFromUrl rejects non-web schemes", () => {
  assert.equal(siteKeyFromUrl("chrome://extensions"), null);
  assert.equal(siteKeyFromUrl("about:blank"), null);
  assert.equal(siteKeyFromUrl("not a url"), null);
  assert.equal(siteKeyFromUrl(""), null);
  assert.equal(siteKeyFromUrl("file:///C:/x.html"), "file://");
});

test("patterns", () => {
  assert.equal(originPatternForSite("example.com"), "*://example.com/*");
  assert.equal(originPatternForSite("file://"), null);
  assert.equal(urlPatternForSite("file://"), "file:///*");
});

test("hostsForSite adds www only for real names", () => {
  assert.deepEqual(hostsForSite("example.com"), ["example.com", "www.example.com"]);
  assert.deepEqual(hostsForSite("127.0.0.1"), ["127.0.0.1"]);
  assert.deepEqual(hostsForSite("localhost"), ["localhost"]);
  assert.deepEqual(hostsForSite("file://"), []);
  assert.deepEqual(hostsForSite(null), []);
});
