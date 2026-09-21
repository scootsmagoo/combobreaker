import test from "node:test";
import assert from "node:assert/strict";
import { describeDownloadError, shortDownloadError } from "../lib/download_errors.js";

const BOT =
  "yt-dlp exited with code 1. ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies.";

test("bot check without cookies points at the cookies switch", () => {
  const d = describeDownloadError(BOT);
  assert.equal(d.kind, "bot-check");
  assert.equal(d.action, "options-downloads");
  assert.match(d.hint, /Use my browser’s cookies/);
});

test("bot check with cookies already sent asks for a sign-in instead", () => {
  const d = describeDownloadError(BOT, { cookiesSent: true });
  assert.equal(d.kind, "bot-check");
  assert.equal(d.action, null);
  assert.match(d.hint, /Sign in to YouTube/);
});

test("sign-in / members-only errors", () => {
  const d = describeDownloadError("ERROR: [youtube] abc: Join this channel to get access to members-only content");
  assert.equal(d.kind, "sign-in");
  assert.equal(d.action, "options-downloads");
  assert.equal(describeDownloadError("ERROR: private video", { cookiesSent: true }).action, null);
});

test("ordinary errors get no hint", () => {
  assert.equal(describeDownloadError("yt-dlp exited with code 1. ERROR: Unable to download webpage: timed out"), null);
  assert.equal(describeDownloadError(""), null);
  assert.equal(describeDownloadError(null), null);
});

test("shortDownloadError strips the exit-code prefix and trailing links", () => {
  assert.equal(shortDownloadError(BOT), "[youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.");
  assert.equal(shortDownloadError("ERROR: disk full"), "disk full");
  assert.equal(shortDownloadError(""), "");
});
