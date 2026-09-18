// Per-site custom JS via chrome.userScripts.
//
// MV3 gives an extension two ways to run user-authored code in a page:
//   - chrome.userScripts: exempt from the page CSP, true document_start.
//     Preferred whenever Chrome lets us.
//   - chrome.scripting.executeScript in the MAIN world, which then adds a
//     <script> from inside the page. Subject to the page's CSP, and runs a
//     little later. This is runUserJsFallback() below.
// (A content script creating an inline <script> itself is not an option: the
// extension's own CSP blocks it on every page.)
//
// Availability: needs the "userScripts" permission plus the user-facing switch
// (chrome://extensions → ComboBreaker → "Allow User Scripts" on Chrome 138+,
// Developer mode before that). When unavailable, content/site_injector.js
// sends "run-user-js" and we use the fallback.
//
// chrome.storage.local:
//   cb_userscript_sites : string[]   site keys currently registered here;
//                                    site_injector.js skips its inline
//                                    fallback for these.

import { listSites, getSite } from "../lib/storage.js";
import { siteKeyFromUrl, hostsForSite } from "../lib/site.js";

const ID_PREFIX = "cbjs:";
const SITES_KEY = "cb_userscript_sites";

export function userScriptsAvailable() {
  try {
    // Throws when the permission is missing or the user switch is off.
    chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

export function matchesForSite(siteKey) {
  if (!siteKey) return [];
  if (siteKey === "file://") return ["file:///*"];
  return hostsForSite(siteKey).map((h) => `*://${h}/*`);
}

export function wrapUserCode(code) {
  return `try{\n${code}\n}catch(e){console.error("[ComboBreaker user JS]",e);}`;
}

let syncing = Promise.resolve();

// Serialised: storage.onChanged can fire twice for one save (sync + local).
export function syncUserScripts() {
  syncing = syncing.then(doSync, doSync);
  return syncing;
}

async function doSync() {
  if (!userScriptsAvailable()) {
    await chrome.storage.local.set({ [SITES_KEY]: [] });
    return { available: false, registered: [] };
  }
  const sites = (await listSites()).filter((s) => s.settings.jsEnabled && s.settings.js);
  const existing = await chrome.userScripts.getScripts();
  const ours = existing.filter((s) => s.id.startsWith(ID_PREFIX)).map((s) => s.id);
  if (ours.length) await chrome.userScripts.unregister({ ids: ours });

  const registered = [];
  const errors = {};
  for (const { siteKey, settings } of sites) {
    try {
      await chrome.userScripts.register([
        {
          id: ID_PREFIX + siteKey,
          matches: matchesForSite(siteKey),
          js: [{ code: wrapUserCode(settings.js) }],
          runAt: "document_start",
          world: "MAIN",
          allFrames: false,
        },
      ]);
      registered.push(siteKey);
    } catch (e) {
      // Bad match pattern etc. — leave this site on the inline fallback.
      console.warn("[ComboBreaker] userScripts.register failed for", siteKey, e);
      errors[siteKey] = String((e && e.message) || e);
    }
  }
  await chrome.storage.local.set({ [SITES_KEY]: registered });
  return { available: true, registered, errors };
}

export function watchUserScripts() {
  chrome.storage.onChanged.addListener((changes, area) => {
    const keys = Object.keys(changes);
    const hit =
      (area === "sync" && keys.some((k) => k.startsWith("site:"))) ||
      (area === "local" && keys.some((k) => k.startsWith("sitecode:")));
    if (hit) syncUserScripts().catch((e) => console.warn("[ComboBreaker] userScripts sync", e));
  });
}

// Fallback path, requested by site_injector.js for its own tab.
export async function runUserJsFallback(sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null || sender.frameId !== 0) return { ran: false };
  const site = await getSite(siteKeyFromUrl(sender.tab.url || sender.url));
  if (!site.jsEnabled || !site.js) return { ran: false };
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    injectImmediately: true,
    args: [wrapUserCode(site.js)],
    func: injectInlineScript,
  });
  return { ran: true };
}

// One-shot run (Snippets). chrome.userScripts.execute (Chrome 135+) is CSP-
// proof; otherwise fall back to a page-created <script>, which the page's CSP
// may veto.
export async function runCodeInTab(tabId, code) {
  if (tabId == null || typeof code !== "string" || !code.trim()) throw new Error("nothing to run");
  const wrapped = wrapUserCode(code);
  if (userScriptsAvailable() && typeof chrome.userScripts.execute === "function") {
    await chrome.userScripts.execute({
      target: { tabId },
      js: [{ code: wrapped }],
      world: "MAIN",
      injectImmediately: true,
    });
    return { via: "userScripts" };
  }
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    injectImmediately: true,
    args: [wrapped],
    func: injectInlineScript,
  });
  return { via: "scripting" };
}

function injectInlineScript(code) {
  const s = document.createElement("script");
  s.textContent = code;
  (document.head || document.documentElement).appendChild(s);
  s.remove();
}
