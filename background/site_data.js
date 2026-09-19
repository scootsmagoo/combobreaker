// Site data: the "nuke" wipe and auto-clear when a site's last tab closes.

import { hostsForSite, siteKeyFromUrl } from "../lib/site.js";
import { getSite, listSites } from "../lib/storage.js";

// ---------- Site data nuke ----------

export async function nukeSiteData(siteKey, tabUrl, extraOrigins) {
  const origins = new Set(extraOrigins || []);
  try {
    const u = new URL(tabUrl);
    if (/^https?:$/.test(u.protocol)) origins.add(u.origin);
  } catch {}
  for (const host of hostsForSite(siteKey)) {
    origins.add(`https://${host}`);
    origins.add(`http://${host}`);
  }
  if (!origins.size) throw new Error("no http(s) origin for this tab");
  await chrome.browsingData.remove(
    { origins: [...origins] },
    {
      cookies: true,
      localStorage: true,
      indexedDB: true,
      cacheStorage: true,
      serviceWorkers: true,
      fileSystems: true,
    }
  );
  return { origins: [...origins] };
}

// ---------- Auto-clear on close ----------
//
// Sites with autoClear get the same wipe as "Nuke all site data" once their
// last tab is gone. Each tab remembers the auto-clear sites it has shown
// (chrome.storage.session, so it survives SW sleeps). Nothing is cleared while
// the tab is merely navigating: a login that bounces through another domain
// and back must not lose its cookies halfway. Quitting the browser can kill
// the worker before onRemoved runs, so boot() sweeps as well.

const TABSITES_KEY = (tabId) => `tabsites:${tabId}`;

// Stored per tab as { [siteKey]: origin[] }. The exact origins matter:
// localStorage and IndexedDB are per origin, port included.
async function recordAutoClearTab(tabId, url) {
  const siteKey = siteKeyFromUrl(url);
  if (tabId == null || tabId < 0 || !siteKey || siteKey === "file://") return;
  if (!(await getSite(siteKey)).autoClear) return;
  const key = TABSITES_KEY(tabId);
  const seen = (await chrome.storage.session.get(key))[key] || {};
  const origin = new URL(url).origin;
  const origins = seen[siteKey] || [];
  if (origins.includes(origin)) return;
  await chrome.storage.session.set({ [key]: { ...seen, [siteKey]: [...origins, origin] } });
}

async function openSiteKeys(exceptTabId) {
  const tabs = await chrome.tabs.query({});
  return new Set(tabs.filter((t) => t.id !== exceptTabId).map((t) => siteKeyFromUrl(t.url)).filter(Boolean));
}

// seen: { [siteKey]: origin[] }
async function autoClearIfGone(seen, exceptTabId) {
  const siteKeys = Object.keys(seen);
  if (!siteKeys.length) return [];
  const open = await openSiteKeys(exceptTabId);
  const cleared = [];
  for (const siteKey of siteKeys) {
    if (open.has(siteKey) || !(await getSite(siteKey)).autoClear) continue;
    await nukeSiteData(siteKey, null, seen[siteKey]);
    cleared.push(siteKey);
  }
  return cleared;
}

// Called from boot() and when the setting is flipped: note tabs that are
// already showing an auto-clear site, clear auto-clear sites nobody has open.
export async function sweepAutoClear() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) await recordAutoClearTab(t.id, t.url);
  const sites = (await listSites()).filter((s) => s.settings.autoClear).map((s) => [s.siteKey, []]);
  return { cleared: await autoClearIfGone(Object.fromEntries(sites)) };
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) recordAutoClearTab(tabId, info.url).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const key = TABSITES_KEY(tabId);
    const seen = (await chrome.storage.session.get(key))[key] || {};
    await chrome.storage.session.remove(key);
    await autoClearIfGone(seen, tabId);
  } catch (e) {
    console.warn("[ComboBreaker] auto-clear failed:", e);
  }
});
