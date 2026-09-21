import test from "node:test";
import assert from "node:assert/strict";
import { helperInstallCommand, helperPermissionState, RELOAD_COOLDOWN_MS } from "../lib/helper.js";

test("helperInstallCommand embeds the extension id", () => {
  const id = "gimlbdjceegoblababecnbheejbmaoff";
  const cmd = helperInstallCommand(id);
  assert.match(cmd, /^curl -fsSL https:\/\/raw\.githubusercontent\.com\/.*\/install\.sh \| bash -s -- gimlbdjceegoblababecnbheejbmaoff$/);
});

test("helperPermissionState: bound API wins regardless of bookkeeping", () => {
  assert.equal(helperPermissionState({ granted: true, bound: true }), "ready");
  // A stale reload marker must not matter once the API is there.
  assert.equal(helperPermissionState({ granted: true, bound: true, lastReloadAt: Date.now() }), "ready");
});

test("helperPermissionState: no grant means Allow, whatever else is true", () => {
  assert.equal(helperPermissionState({ granted: false, bound: false }), "needs-permission");
  assert.equal(helperPermissionState({ granted: false, bound: false, lastReloadAt: Date.now() }), "needs-permission");
});

test("helperPermissionState: granted but unbound reloads once, then asks for a browser restart", () => {
  const now = 1_000_000_000;
  // Fresh grant in a worker started before it: reload.
  assert.equal(helperPermissionState({ granted: true, bound: false, lastReloadAt: 0, now }), "needs-reload");
  // Just reloaded and still unbound: reloading again would loop forever.
  assert.equal(helperPermissionState({ granted: true, bound: false, lastReloadAt: now - 5_000, now }), "needs-browser-restart");
  assert.equal(
    helperPermissionState({ granted: true, bound: false, lastReloadAt: now - RELOAD_COOLDOWN_MS + 1, now }),
    "needs-browser-restart"
  );
  // Old marker (e.g. the permission was revoked and granted again later): reload again.
  assert.equal(helperPermissionState({ granted: true, bound: false, lastReloadAt: now - RELOAD_COOLDOWN_MS, now }), "needs-reload");
});
