import test from "node:test";
import assert from "node:assert/strict";
import { cleanLinks, formatLinks, mergeLinkSelect, DEFAULT_LINK_SELECT } from "../lib/links.js";

const PAGE = "https://news.example.com/front?p=1#top";

test("cleanLinks: http(s) only, no same-page anchors, de-duplicated in page order", () => {
  const got = cleanLinks(
    [
      { url: "https://a.example/1", text: "  First\n  story " },
      { url: "javascript:void(0)", text: "js" },
      { url: "mailto:x@example.com", text: "mail" },
      { url: "https://news.example.com/front?p=1#comments", text: "same page" },
      { url: "https://news.example.com/front?p=2#comments", text: "other page, with hash" },
      { url: "https://a.example/1", text: "duplicate" },
      { url: "not a url", text: "junk" },
      { url: "http://b.example/", text: "" },
      null,
    ],
    PAGE
  );
  assert.deepEqual(got, [
    { url: "https://a.example/1", text: "First story" },
    { url: "https://news.example.com/front?p=2#comments", text: "other page, with hash" },
    { url: "http://b.example/", text: "" },
  ]);
  assert.deepEqual(cleanLinks("nope", PAGE), []);
  assert.equal(cleanLinks([{ url: "https://a.example/#x" }], "garbage").length, 1);
});

test("formatLinks: urls, tab-separated titles, markdown with escaping", () => {
  const links = [
    { url: "https://a.example/1", text: "First [live]" },
    { url: "https://a.example/wiki/Foo_(bar)", text: "" },
  ];
  assert.equal(formatLinks(links, "urls"), "https://a.example/1\nhttps://a.example/wiki/Foo_(bar)");
  assert.equal(formatLinks(links, "titles"), "First [live]\thttps://a.example/1\nhttps://a.example/wiki/Foo_(bar)\thttps://a.example/wiki/Foo_(bar)");
  assert.equal(
    formatLinks(links, "markdown"),
    "- [First \\[live\\]](https://a.example/1)\n- [https://a.example/wiki/Foo_(bar)](https://a.example/wiki/Foo_(bar%29)"
  );
  assert.equal(formatLinks([], "urls"), "");
});

test("mergeLinkSelect fills defaults and rejects unknown values", () => {
  assert.deepEqual(mergeLinkSelect(undefined), DEFAULT_LINK_SELECT);
  assert.deepEqual(mergeLinkSelect({ enabled: false, trigger: "right", action: "copy", copyFormat: "markdown", smart: false }), {
    enabled: false,
    trigger: "right",
    action: "copy",
    copyFormat: "markdown",
    smart: false,
  });
  assert.deepEqual(mergeLinkSelect({ trigger: "ctrl", action: "bookmark", copyFormat: 7 }), DEFAULT_LINK_SELECT);
});
