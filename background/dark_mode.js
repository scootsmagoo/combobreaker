// Dark mode: injects and drives the vendored Dark Reader per tab.

import { DARK_DETECT_KEY, effectiveDarkModeFor, getGlobal, getSite, setGlobal, setSite } from "../lib/storage.js";

// ---------- Dark mode (Dark Reader engine) ----------
//
// Architecture:
//   - vendor/darkreader.js is loaded into MAIN world, on demand, per tab.
//   - We track which tabs already have the bundle so we don't re-inject 336 KB
//     on every toggle. The set is cleared when a tab navigates or closes.
//   - Toggles update storage; site_injector.js (in each tab) listens for
//     storage changes and posts `apply-dark-mode` here, which injects /
//     enables / disables Dark Reader in the right tab(s).

const DR_LOADED_TABS = new Set();

chrome.tabs.onRemoved.addListener((tabId) => DR_LOADED_TABS.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") DR_LOADED_TABS.delete(tabId);
});

export async function applyDarkMode(tabId, enabled, theme) {
  if (tabId == null) return { ok: false, reason: "no tab" };

  if (enabled) {
    if (!DR_LOADED_TABS.has(tabId)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          // The guards keep an AMD loader on the page from swallowing the bundle.
          files: ["content/dr_amd_guard_on.js", "vendor/darkreader.js", "content/dr_amd_guard_off.js"],
          world: "MAIN",
          injectImmediately: true,
        });
        // Install the cross-origin fetch proxy. Dark Reader runs in MAIN
        // world and so its window.fetch is subject to page CORS; routing
        // stylesheet fetches back through the SW (which has <all_urls>)
        // is the documented escape hatch.
        await chrome.scripting.executeScript({
          target: { tabId },
          func: installDarkReaderFetchProxy,
          world: "MAIN",
          injectImmediately: true,
        });
        DR_LOADED_TABS.add(tabId);
      } catch (e) {
        // Likely an unsupported page (chrome://, file:, store, etc.)
        return { ok: false, reason: String(e.message || e) };
      }
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (t) => {
        if (window.DarkReader && typeof window.DarkReader.enable === "function") {
          window.DarkReader.enable(t || {});
        }
      },
      args: [theme || {}],
      world: "MAIN",
      injectImmediately: true,
    });
    return { ok: true, enabled: true };
  }

  // Disable. Only worth poking the page if we actually loaded the bundle.
  if (!DR_LOADED_TABS.has(tabId)) return { ok: true, enabled: false };
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (window.DarkReader && typeof window.DarkReader.disable === "function") {
        window.DarkReader.disable();
      }
    },
    world: "MAIN",
  });
  // Also clear the anti-flash preamble that site_injector left, in the
  // unusual case where it's still hanging around in isolated world.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const p = document.getElementById("__cb_dark_preamble__");
      if (p) p.remove();
    },
  });
  return { ok: true, enabled: false };
}

export async function toggleDarkModeGlobal() {
  const g = await getGlobal();
  const next = !g.darkMode.enabled;
  await setGlobal({ darkMode: { enabled: next } });
  return { darkMode: next };
}

// Runs in MAIN world right after vendor/darkreader.js is injected.
// Sets up a postMessage-based bridge so Dark Reader can fetch
// cross-origin stylesheets through our service worker (which has the
// <all_urls> permission and isn't bound by page-level CORS).
function installDarkReaderFetchProxy() {
  if (window.__cb_dr_fetch_installed) return;
  window.__cb_dr_fetch_installed = true;
  if (!window.DarkReader || typeof window.DarkReader.setFetchMethod !== "function") return;

  const REQ = "__cb_dr_request__";
  const RES = "__cb_dr_response__";
  const pending = new Map();
  let nextId = 0;

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || typeof m !== "object" || m.kind !== RES) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) {
      p.reject(new Error(m.error));
    } else {
      p.resolve(
        new Response(m.body, {
          status: 200,
          headers: { "Content-Type": m.contentType || "text/css" },
        })
      );
    }
  });

  window.DarkReader.setFetchMethod((url) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      window.postMessage({ kind: REQ, id, url: String(url) }, "*");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("[ComboBreaker] dark-mode fetch timed out: " + url));
        }
      }, 15000);
    })
  );
}

// SW-side fetcher used by the bridge. Best-effort: returns text + the
// content-type header. CSS-like resources are the only thing we expect.
export async function drFetch(url) {
  if (!url || typeof url !== "string") throw new Error("url required");
  const r = await fetch(url, { credentials: "omit" });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  const body = await r.text();
  const contentType = r.headers.get("content-type") || "text/css";
  return { body, contentType };
}

// Per-site toggle: cycles based on what's *currently visible* on this page,
// matching how Dark Reader's shortcut behaves.
//   currently dark  -> set override "off"
//   currently light -> set override "on"
export async function toggleDarkModeSite(siteKey) {
  if (!siteKey) return null;
  const [g, site] = await Promise.all([getGlobal(), getSite(siteKey)]);
  let currentlyDark = effectiveDarkModeFor(g, site);
  // In Auto, a site that is dark on its own is not being darkened by us, so
  // the shortcut should force Dark Reader on rather than "off".
  if (currentlyDark && site.darkMode == null && g.darkMode.detectDark) {
    const verdict = ((await chrome.storage.local.get(DARK_DETECT_KEY))[DARK_DETECT_KEY] || {})[siteKey];
    if (verdict && verdict.dark) currentlyDark = false;
  }
  const nextOverride = currentlyDark ? "off" : "on";
  await setSite(siteKey, { darkMode: nextOverride });
  return { override: nextOverride };
}
