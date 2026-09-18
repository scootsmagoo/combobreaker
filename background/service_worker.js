import {
  ensureSchema,
  getGlobal,
  setGlobal,
  getSite,
  setSite,
  listSites,
  effectiveDarkModeFor,
} from "../lib/storage.js";
import { siteKeyFromUrl, originPatternForSite, hostsForSite } from "../lib/site.js";
import {
  ytdlpStatus,
  ytdlpDownload,
  ytdlpCancel,
  ytdlpReveal,
  ytdlpJobs,
  ytdlpClearJobs,
  ytdlpUpdate,
} from "./ytdlp_bridge.js";
import {
  syncUserScripts,
  watchUserScripts,
  userScriptsAvailable,
  runUserJsFallback,
  runCodeInTab,
} from "./user_scripts.js";
import { downloadWindowsInstaller } from "./helper_installer.js";
import { buildSiteRules, siteNeedsRules, HEADER_RESOURCE_TYPES } from "../lib/site_rules.js";

async function boot() {
  await ensureSchema();
  await applyAdblockState();
  await reapplyAllHeaderRules();
  await syncUserScripts();
  await sweepAutoClear();
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
watchUserScripts();

// ---------- Message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const result = await handleMessage(msg, sender);
      sendResponse({ ok: true, result });
    } catch (err) {
      console.error("[ComboBreaker] message error:", err);
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg?.type) {
    case "get-site-state":
      return await getSiteState(msg.siteKey);
    case "set-js-enabled":
      return await setJsEnabled(msg.siteKey, msg.enabled);
    case "set-site":
      return await setSite(msg.siteKey, msg.patch);
    case "set-global":
      return await setGlobal(msg.patch);
    case "apply-dark-mode":
      return await applyDarkMode(sender?.tab?.id, msg.enabled, msg.theme);
    case "cb-dr-fetch":
      return await drFetch(msg.url);
    case "toggle-darkmode-global":
      return await toggleDarkModeGlobal();
    case "toggle-darkmode-site":
      return await toggleDarkModeSite(msg.siteKey);
    case "launch-tool":
      return await launchTool(msg.tool, msg.tabId, sender);
    case "capture-fullpage":
      return await captureFullPage(msg.tabId);
    case "set-encoding":
      return await setEncoding(msg.tabId, msg.encoding);
    case "apply-adblock":
      return await applyAdblockState();
    case "get-redirect-chain":
      return await getRedirectChain(msg.tabId);
    case "clear-redirect-chain":
      return await clearRedirectChain(msg.tabId);
    case "get-response-headers":
      return await getResponseHeaders(msg.tabId);
    case "apply-site-headers":
      return await applySiteHeaderRules(msg.siteKey);
    case "media-found":
      return await pushMediaItem(sender?.tab?.id, msg.item);
    case "media-list":
      return await getMediaList(msg.tabId);
    case "media-clear":
      return await clearMediaList(msg.tabId);
    case "media-download":
      return await downloadMedia(msg.url, msg.filename);
    case "media-list-mine":
      return await getMediaList(sender?.tab?.id);
    case "open-hls-downloader":
      return await openHlsDownloader(msg.url, msg.title, msg.referer);
    case "overlay-download":
      return await overlayDownload(msg, sender);
    case "ytdlp-status":
      return await ytdlpStatus(!!msg.force);
    case "ytdlp-download":
      return await ytdlpDownload({
        url: msg.url,
        quality: msg.quality,
        title: msg.title,
        tabId: msg.tabId != null ? msg.tabId : sender?.tab?.id,
        itemId: msg.itemId,
        page: msg.page,
        referer: msg.referer,
        thumb: msg.thumb,
        site: msg.site,
      });
    case "ytdlp-cancel":
      return await ytdlpCancel(msg.jobId);
    case "ytdlp-reveal":
      return await ytdlpReveal(msg.path);
    case "ytdlp-jobs":
      return await ytdlpJobs();
    case "ytdlp-clear-jobs":
      return await ytdlpClearJobs();
    case "run-snippet":
      return await runCodeInTab(msg.tabId, msg.code);
    case "apply-auto-clear":
      return await sweepAutoClear();
    case "nuke-site-data":
      return await nukeSiteData(msg.siteKey, msg.tabUrl);
    case "run-user-js":
      return await runUserJsFallback(sender);
    case "userscripts-status":
      // Also re-syncs, so flipping "Allow User Scripts" takes effect as soon
      // as the options page is opened.
      return { ...(await syncUserScripts()), available: userScriptsAvailable() };
    case "ytdlp-update":
      return await ytdlpUpdate();
    case "open-helper-setup":
      return await openHelperSetup();
    case "helper-installer-download":
      return await downloadWindowsInstaller();
    case "open-options":
      return await openOptionsSection(msg.section);
    case "overlay-list-all":
      return await overlayListAllFrames(msg.tabId);
    case "reader-extract":
      return await extractReaderForTab(msg.tabId);
    case "reader-open":
      return await openReaderView(msg.tabId);
    case "structured-data-extract":
      return await extractStructuredDataForTab(msg.tabId);
    case "structured-data-open":
      return await openStructuredDataView(msg.tabId);
    case "set-viewport-preset":
      return await setViewportPreset(msg.tabId, msg.preset, msg.siteKey);
    case "list-tab-sessions":
      return await listTabSessions();
    case "save-tab-session":
      return await saveTabWindowSession(msg.name);
    case "delete-tab-session":
      return await deleteTabSession(msg.sessionId);
    case "restore-tab-session":
      return await restoreTabSession(msg.sessionId);
    case "find-duplicate-tabs":
      return findDuplicateTabGroups();
    case "close-duplicate-tabs":
      return await closeDuplicateTabGroups();
    default:
      throw new Error(`unknown message type: ${msg?.type}`);
  }
}

// ---------- Per-site JS toggle (chrome.contentSettings) ----------

async function getSiteState(siteKey) {
  if (!siteKey) return null;
  const settings = await getSite(siteKey);
  const global = await getGlobal();
  const jsEnabled = await getJavascriptSetting(siteKey);
  return { siteKey, settings, global, jsEnabled };
}

async function getJavascriptSetting(siteKey) {
  const pattern = originPatternForSite(siteKey);
  if (!pattern) return true;
  return new Promise((resolve) => {
    chrome.contentSettings.javascript.get(
      { primaryUrl: `https://${siteKey}/` },
      (details) => {
        if (chrome.runtime.lastError || !details) return resolve(true);
        resolve(details.setting !== "block");
      }
    );
  });
}

async function setJsEnabled(siteKey, enabled) {
  const pattern = originPatternForSite(siteKey);
  if (!pattern) throw new Error("cannot set JS for non-http site");
  await new Promise((resolve, reject) => {
    chrome.contentSettings.javascript.set(
      {
        primaryPattern: pattern,
        setting: enabled ? "allow" : "block",
        scope: "regular",
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      }
    );
  });
  return { jsEnabled: enabled };
}

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

async function applyDarkMode(tabId, enabled, theme) {
  if (tabId == null) return { ok: false, reason: "no tab" };

  if (enabled) {
    if (!DR_LOADED_TABS.has(tabId)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["vendor/darkreader.js"],
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

async function toggleDarkModeGlobal() {
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
async function drFetch(url) {
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
async function toggleDarkModeSite(siteKey) {
  if (!siteKey) return null;
  const [g, site] = await Promise.all([getGlobal(), getSite(siteKey)]);
  const currentlyDark = effectiveDarkModeFor(g, site);
  const nextOverride = currentlyDark ? "off" : "on";
  await setSite(siteKey, { darkMode: nextOverride });
  return { override: nextOverride };
}

// ---------- On-demand tool launcher ----------

const TOOL_FILES = {
  "color-picker": "tools/color_picker.js",
  ruler: "tools/ruler.js",
  whatfont: "tools/whatfont.js",
};

async function launchTool(tool, tabIdOverride, sender) {
  const tabId =
    tabIdOverride ??
    sender?.tab?.id ??
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!tabId) throw new Error("no active tab");

  const file = TOOL_FILES[tool];
  if (!file) throw new Error(`unknown tool: ${tool}`);

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [file],
    world: "ISOLATED",
  });
  return { tabId, tool };
}

// ---------- Full-page screenshot (scroll + stitch) ----------

async function captureFullPage(tabIdOverride) {
  const tabId =
    tabIdOverride ??
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!tabId) throw new Error("no active tab");

  const tab = await chrome.tabs.get(tabId);
  const windowId = tab.windowId;

  const [{ result: dims }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      docHeight: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      ),
      docWidth: Math.max(
        document.body.scrollWidth,
        document.documentElement.scrollWidth
      ),
      dpr: window.devicePixelRatio || 1,
    }),
  });

  const shots = [];
  let y = 0;
  while (y < dims.docHeight) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (yy) => window.scrollTo(0, yy),
      args: [y],
    });
    await new Promise((r) => setTimeout(r, 250));
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "png",
    });
    shots.push({ y, dataUrl });
    y += dims.innerHeight;
    await new Promise((r) => setTimeout(r, 100));
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (sx, sy) => window.scrollTo(sx, sy),
    args: [dims.scrollX, dims.scrollY],
  });

  const stitched = await stitchShots(shots, dims);
  const filename = `combobreaker-${siteKeyFromUrl(tab.url) || "page"}-${Date.now()}.png`;
  await chrome.downloads.download({
    url: stitched,
    filename,
    saveAs: false,
  });
  return { filename, count: shots.length };
}

async function stitchShots(shots, dims) {
  const totalHeight = dims.docHeight * dims.dpr;
  const totalWidth = dims.innerWidth * dims.dpr;
  const canvas = new OffscreenCanvas(totalWidth, totalHeight);
  const ctx = canvas.getContext("2d");

  for (const shot of shots) {
    const blob = await (await fetch(shot.dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const drawY = shot.y * dims.dpr;
    let sourceClipY = 0;
    let sourceClipHeight = bmp.height;
    if (drawY + bmp.height > totalHeight) {
      sourceClipHeight = totalHeight - drawY;
      sourceClipY = bmp.height - sourceClipHeight;
    }
    ctx.drawImage(
      bmp,
      0,
      sourceClipY,
      bmp.width,
      sourceClipHeight,
      0,
      drawY + sourceClipY,
      bmp.width,
      sourceClipHeight
    );
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------- Encoding override ----------
// Re-fetch the page bytes, decode with a chosen encoding, write into the tab.

async function setEncoding(tabIdOverride, encoding) {
  const tabId =
    tabIdOverride ??
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!tabId) throw new Error("no active tab");
  if (!encoding) throw new Error("encoding required");

  const tab = await chrome.tabs.get(tabId);
  const url = tab.url;
  if (!/^https?:/.test(url)) throw new Error("only http(s) supported");

  const resp = await fetch(url, { credentials: "include" });
  const buf = await resp.arrayBuffer();
  const decoder = new TextDecoder(encoding, { fatal: false });
  const html = decoder.decode(buf);

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (h) => {
      document.open();
      document.write(h);
      document.close();
    },
    args: [html],
  });
  return { encoding };
}

// ---------- Adblock toggle ----------

// Levels: "basic" = rules/basic_block.json (~40 big ad/tracking companies),
// "strong" = basic + rules/strong_block.json (Peter Lowe's list, regenerate
// with scripts/update_blocklist.js). Per-site pause is one dynamic
// allowAllRequests rule on the paused sites' top-level documents; its
// priority sits above the block rules (1) and below header rules (3), because
// an allow rule also cancels modifyHeaders rules of equal or lower priority.

const ADBLOCK_RULESETS = { basic: "combobreaker_basic_block", strong: "combobreaker_strong_block" };
const ADBLOCK_PAUSE_RULE_ID = 900001;
const ADBLOCK_PAUSE_PRIORITY = 2;

async function applyAdblockState() {
  const { adblockLevel } = await getGlobal();
  const want = adblockLevel === "strong" ? ["basic", "strong"] : adblockLevel === "basic" ? ["basic"] : [];
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: want.map((k) => ADBLOCK_RULESETS[k]),
    disableRulesetIds: Object.keys(ADBLOCK_RULESETS)
      .filter((k) => !want.includes(k))
      .map((k) => ADBLOCK_RULESETS[k]),
  });
  const paused = await applyAdblockPauses();
  return { adblockLevel, adblockEnabled: adblockLevel !== "off", paused };
}

async function applyAdblockPauses() {
  const paused = (await listSites())
    .filter((s) => s.settings.adblockPaused && s.siteKey !== "file://")
    .map((s) => s.siteKey);
  const addRules = paused.length
    ? [
        {
          id: ADBLOCK_PAUSE_RULE_ID,
          priority: ADBLOCK_PAUSE_PRIORITY,
          action: { type: "allowAllRequests" },
          // requestDomains also matches subdomains (www.).
          condition: { requestDomains: paused, resourceTypes: ["main_frame"] },
        },
      ]
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ADBLOCK_PAUSE_RULE_ID], addRules });
  return paused;
}

// ---------- Site data nuke ----------

async function nukeSiteData(siteKey, tabUrl, extraOrigins) {
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
async function sweepAutoClear() {
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

// ---------- Redirect tracer ----------
// We log main_frame redirects per tab to chrome.storage.session so the chain
// survives service-worker sleeps. Each entry is one of:
//   { type: "start",    url, time }
//   { type: "redirect", from, to, status, time }
//   { type: "end",      url, status, time }
//
// A new "start" entry resets the chain for that tab.

const REDIRECT_KEY = (tabId) => `redirects:${tabId}`;
const MAX_CHAIN = 50;

async function pushRedirect(tabId, entry) {
  if (tabId < 0) return;
  const key = REDIRECT_KEY(tabId);
  const data = await chrome.storage.session.get(key);
  let chain = data[key] || [];
  if (entry.type === "start") chain = [];
  chain.push(entry);
  if (chain.length > MAX_CHAIN) chain = chain.slice(-MAX_CHAIN);
  await chrome.storage.session.set({ [key]: chain });
}

async function getRedirectChain(tabId) {
  if (tabId == null || tabId < 0) return [];
  const key = REDIRECT_KEY(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] || [];
}

async function clearRedirectChain(tabId) {
  if (tabId == null || tabId < 0) return;
  await chrome.storage.session.remove(REDIRECT_KEY(tabId));
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    pushRedirect(details.tabId, {
      type: "start",
      url: details.url,
      time: Date.now(),
    });
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    pushRedirect(details.tabId, {
      type: "redirect",
      from: details.url,
      to: details.redirectUrl,
      status: details.statusCode,
      time: Date.now(),
    });
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    pushRedirect(details.tabId, {
      type: "end",
      url: details.url,
      status: details.statusCode,
      time: Date.now(),
    });
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(REDIRECT_KEY(tabId)).catch(() => {});
});

// ---------- Response-header capture (per tab) ----------
// Mirrors the redirect tracer: main_frame only, kept in chrome.storage.session
// so the data survives SW sleeps. We store the *latest* main_frame response
// (chain end), not every request — the popup is for "what's the current page".

const HEADERS_KEY = (tabId) => `headers:${tabId}`;

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    const entry = {
      url: details.url,
      status: details.statusCode,
      time: Date.now(),
      headers: (details.responseHeaders || []).map((h) => ({
        name: h.name,
        value: h.value ?? (h.binaryValue ? "(binary)" : ""),
      })),
    };
    chrome.storage.session
      .set({ [HEADERS_KEY(details.tabId)]: entry })
      .catch(() => {});
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders"]
);

async function getResponseHeaders(tabId) {
  if (tabId == null || tabId < 0) return null;
  const key = HEADERS_KEY(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(HEADERS_KEY(tabId)).catch(() => {});
});

// ---------- Per-site header rules (DNR dynamic rules) ----------
//
// lib/site_rules.js turns each site's requestHeaders / responseHeaders arrays,
// blockThirdPartyCookies and referrerPolicy into DNR modifyHeaders rules.
// Stable rule IDs are stored in chrome.storage.local so updates can cleanly
// remove the old rules before adding the new ones.
//
// Layout in chrome.storage.local:
//   cb_header_rule_seq : number              (monotonic, never reused)
//   cb_header_rule_map : { [siteKey]: number[] }
//
// Header overrides match on `requestDomains` (requests going *to* the site);
// the privacy rules match on `initiatorDomains` (requests the site's pages make).

async function nextHeaderRuleId() {
  const data = await chrome.storage.local.get("cb_header_rule_seq");
  // Start above any plausible static-ruleset ID. DNR docs reserve no specific
  // range, but keeping our IDs in the millions keeps the namespace tidy.
  const next = (data.cb_header_rule_seq || 1_000_000) + 1;
  await chrome.storage.local.set({ cb_header_rule_seq: next });
  return next;
}

async function getHeaderRuleMap() {
  const data = await chrome.storage.local.get("cb_header_rule_map");
  return data.cb_header_rule_map || {};
}

async function setHeaderRuleMap(map) {
  await chrome.storage.local.set({ cb_header_rule_map: map });
}

async function applySiteHeaderRules(siteKey) {
  if (!siteKey) return { applied: 0 };
  const settings = await getSite(siteKey);
  return await syncSiteHeaderRules(siteKey, settings);
}

async function syncSiteHeaderRules(siteKey, settings) {
  const map = await getHeaderRuleMap();
  const oldIds = map[siteKey] || [];
  const newRules = [];
  for (const rule of buildSiteRules(siteKey, settings)) {
    newRules.push({ id: await nextHeaderRuleId(), ...rule });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: oldIds,
    addRules: newRules,
  });

  if (newRules.length) {
    map[siteKey] = newRules.map((r) => r.id);
  } else {
    delete map[siteKey];
  }
  await setHeaderRuleMap(map);

  return { applied: newRules.length };
}

async function reapplyAllHeaderRules() {
  // On startup, reconcile DNR dynamic rules with what's actually in storage.
  // Drop every rule we previously created, then rebuild from current site
  // settings. This keeps things sane after schema changes or storage edits.
  const map = await getHeaderRuleMap();
  const toRemove = [];
  for (const ids of Object.values(map)) toRemove.push(...ids);
  if (toRemove.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: toRemove });
  }
  await setHeaderRuleMap({});

  const sites = await listSites();
  for (const { siteKey, settings } of sites) {
    if (siteNeedsRules(settings)) await syncSiteHeaderRules(siteKey, settings);
  }
}

// ---------- Media (video/audio) sniffer ----------
//
// Tracks media URLs seen on each tab so the popup's Media tab can offer
// downloads. Sources:
//   1. content/media_finder.js scans <video>/<source>/<audio> and posts
//      `media-found` messages.
//   2. webRequest.onResponseStarted catches anything the network ships
//      with a media Content-Type or a known media extension.
// Both feed the same per-tab list, deduped by URL. The list lives in
// chrome.storage.session so it survives SW sleeps but resets per browser
// session and per tab navigation.

const MEDIA_KEY = (tabId) => `media:${tabId}`;
const MAX_MEDIA = 50;

const MEDIA_URL_RE = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv|ogv|ogg|mp3|m4a|wav|flv|ts)(?:$|\?|#)/i;
const MEDIA_MIME_RE = /^(video|audio)\//i;
const HLS_MIME_RE = /^application\/(vnd\.apple\.mpegurl|x-mpegurl)/i;
const DASH_MIME_RE = /^application\/dash\+xml/i;

function classifyByUrl(url) {
  const m = MEDIA_URL_RE.exec(url || "");
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === "m3u8") return "hls";
  if (ext === "mpd") return "dash";
  if (ext === "m4v") return "mp4";
  if (ext === "ogv") return "ogg";
  return ext;
}

function classifyByMime(mime) {
  if (!mime) return null;
  if (HLS_MIME_RE.test(mime)) return "hls";
  if (DASH_MIME_RE.test(mime)) return "dash";
  if (MEDIA_MIME_RE.test(mime)) {
    const sub = mime.split("/")[1].split(";")[0].trim().toLowerCase();
    if (sub === "mp4") return "mp4";
    if (sub === "webm") return "webm";
    if (sub === "ogg") return "ogg";
    if (sub === "mpeg") return mime.startsWith("audio") ? "mp3" : "mpeg";
    return sub || (mime.startsWith("audio") ? "audio" : "video");
  }
  return null;
}

async function pushMediaItem(tabId, item) {
  if (tabId == null || tabId < 0 || !item || !item.url) return null;
  if (typeof item.url !== "string") return null;
  if (item.url.startsWith("blob:") || item.url.startsWith("data:")) return null;

  const key = MEDIA_KEY(tabId);
  const data = await chrome.storage.session.get(key);
  const list = data[key] || [];
  if (list.some((it) => it.url === item.url)) return { added: false };

  const normalized = {
    url: item.url,
    kind: item.kind || classifyByUrl(item.url) || classifyByMime(item.mime) || "video",
    mime: item.mime || "",
    width: item.width || null,
    height: item.height || null,
    duration: item.duration || null,
    title: item.title || "",
    source: item.source || "net",
    time: Date.now(),
  };
  list.push(normalized);
  if (list.length > MAX_MEDIA) list.splice(0, list.length - MAX_MEDIA);
  await chrome.storage.session.set({ [key]: list });
  return { added: true, count: list.length };
}

async function getMediaList(tabId) {
  if (tabId == null || tabId < 0) return [];
  const key = MEDIA_KEY(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] || [];
}

async function clearMediaList(tabId) {
  if (tabId == null || tabId < 0) return;
  await chrome.storage.session.remove(MEDIA_KEY(tabId));
  return { ok: true };
}

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.type === "main_frame" || details.type === "sub_frame") return;
    const headers = details.responseHeaders || [];
    const ct = headers.find((h) => h.name.toLowerCase() === "content-type");
    const mime = ct ? String(ct.value || "").trim() : "";
    const kindByMime = classifyByMime(mime);
    const kindByUrl = classifyByUrl(details.url);
    const kind = kindByMime || kindByUrl;
    if (!kind) return;
    // .ts is the segment format for HLS. Listing each segment would spam
    // the UI; we already track the parent .m3u8.
    if (kindByUrl === "ts") return;
    pushMediaItem(details.tabId, {
      url: details.url,
      kind,
      mime,
      source: "net",
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// New top-level navigation = clean slate for the Media tab.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    chrome.storage.session.remove(MEDIA_KEY(details.tabId)).catch(() => {});
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(MEDIA_KEY(tabId)).catch(() => {});
});

// ---------- Direct media download (mp4/webm/etc.) ----------

function safeFilename(s) {
  return String(s || "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function filenameFromUrl(url, fallbackTitle) {
  try {
    const u = new URL(url);
    const tail = u.pathname.split("/").filter(Boolean).pop() || "";
    if (tail && /\.[a-z0-9]{2,5}$/i.test(tail)) return safeFilename(tail);
    const ext = (classifyByUrl(url) || "bin").toLowerCase();
    const stem = safeFilename(fallbackTitle || u.hostname || "video");
    return `${stem}.${ext === "mpeg" ? "mp3" : ext}`;
  } catch {
    return safeFilename(fallbackTitle || "download.bin");
  }
}

async function downloadMedia(url, filename) {
  if (!url || typeof url !== "string") throw new Error("url required");
  const fname = filename || filenameFromUrl(url);
  const id = await chrome.downloads.download({
    url,
    filename: `combobreaker/${fname}`,
    saveAs: false,
    conflictAction: "uniquify",
  });
  return { id, filename: fname };
}

// ---------- On-page badge downloads (content/media_overlay.js) ----------
//
// The overlay hands us an item (what the user hovered) plus the source they
// picked. Direct files go straight to chrome.downloads. Manifests and
// yt-dlp-only sources go to the native bridge when it's installed; otherwise
// HLS falls back to the in-extension downloader page and everything else
// falls back to "copy a yt-dlp command".

const DIRECT_KINDS = new Set(["mp4", "webm", "mov", "mkv", "ogg", "mp3", "m4a", "wav", "video", "audio", "mpeg"]);

const KIND_EXT = { video: "mp4", audio: "m4a", mpeg: "mp3", ytdlp: "mp4" };

function filenameForItem(item, source) {
  const raw = classifyByUrl(source.url) || source.kind || "mp4";
  const ext = KIND_EXT[raw] || raw;
  let stem = safeFilename(item && item.title ? item.title : "");
  if (!stem || stem.length < 3) {
    try {
      stem = safeFilename(new URL(item && item.page ? item.page : source.url).hostname);
    } catch {
      stem = "video";
    }
  }
  stem = stem.slice(0, 80);
  let tag = "";
  const m = item && item.page ? /\/status\/(\d+)/.exec(item.page) : null;
  if (m) tag = ` [${m[1]}]`;
  else if (source.res) tag = ` [${source.res}]`;
  return `${stem}${tag}.${ext}`;
}

async function overlayDownload(msg, sender) {
  const item = msg.item || {};
  const source = msg.source || {};
  // No explicit preset (badge quick-click) -> the default from options.
  const quality = msg.quality || (await getGlobal()).ytdlp.quality || "best";
  const tabId = msg.tabId != null ? msg.tabId : sender?.tab?.id;
  if (!source.url || !/^https?:/i.test(source.url)) throw new Error("bad source url");

  if (DIRECT_KINDS.has(source.kind)) {
    const r = await downloadMedia(source.url, filenameForItem(item, source));
    return { mode: "direct", filename: r.filename };
  }

  const status = await ytdlpStatus(false);
  if (status.available) {
    const job = await ytdlpDownload({
      url: source.url,
      quality,
      title: item.title || "",
      tabId,
      itemId: item.id,
      page: item.page || msg.referer || "",
      referer: msg.referer || item.page || "",
      thumb: item.thumb || "",
      site: item.site || "",
    });
    return { mode: "ytdlp", jobId: job.id };
  }

  if (source.kind === "hls") {
    await openHlsDownloader(source.url, item.title || "", msg.referer || item.page || "");
    return { mode: "hls-page" };
  }

  // YouTube / DASH without the helper: the page shows a one-time setup prompt.
  return {
    mode: "needs-helper",
    reason: status.error || "Helper not installed.",
    installed: !/not installed/i.test(status.error || ""),
  };
}

async function openHelperSetup() {
  const url = chrome.runtime.getURL("viewer/helper_setup.html");
  // Reuse an open setup tab instead of stacking them.
  const open = await chrome.tabs.query({ url });
  if (open.length) {
    await chrome.tabs.update(open[0].id, { active: true });
    try { await chrome.windows.update(open[0].windowId, { focused: true }); } catch {}
    return { tabId: open[0].id };
  }
  const tab = await chrome.tabs.create({ url });
  return { tabId: tab.id };
}

// Collect badge items from every frame of a tab. chrome.scripting runs in the
// same isolated world as the content script, so the function can call the
// hook media_overlay.js leaves on window.
async function overlayListAllFrames(tabId) {
  if (tabId == null || tabId < 0) return [];
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (typeof window.__cb_overlay_list === "function" ? window.__cb_overlay_list() : null),
    });
  } catch (e) {
    throw new Error(`no access to this page (${e.message})`);
  }
  const out = [];
  const seen = new Set();
  for (const r of results) {
    if (!r || !Array.isArray(r.result)) continue;
    for (const it of r.result) {
      const key = `${r.frameId}:${it.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...it, frameId: r.frameId });
    }
  }
  // Top frame first, then document order within each frame.
  out.sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : a.frameId - b.frameId));
  return out;
}

async function openOptionsSection(section) {
  const url = chrome.runtime.getURL(`options/options.html${section ? "#" + section : ""}`);
  const tab = await chrome.tabs.create({ url });
  return { tabId: tab.id };
}

// ---------- HLS downloader page launcher ----------

async function openHlsDownloader(url, title, referer) {
  if (!url) throw new Error("hls url required");
  const params = new URLSearchParams({ url });
  if (title) params.set("title", title);
  if (referer) params.set("referer", referer);
  const dest = chrome.runtime.getURL(
    `viewer/hls_downloader.html?${params.toString()}`
  );
  const tab = await chrome.tabs.create({ url: dest });
  return { tabId: tab.id };
}

// ---------- Tier 3: browsing (reader, viewport, sessions, no-cache) ----------

const READER_SESSION_KEY = "combobreaker_reader";
const STRUCTURED_DATA_SESSION_KEY = "combobreaker_structured_data";
const TAB_SESSIONS_KEY = "cb_tab_sessions";
const NO_CACHE_SESSION_BASE = 9_000_000;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "browsing-popup") return;
  let watchTab = null;
  port.onMessage.addListener((msg) => {
    if (msg?.type === "active-tab" && msg.noCache && msg.tabId != null && msg.tabId >= 0) {
      watchTab = msg.tabId;
      setNoCacheForPopupTab(watchTab).catch((e) => console.warn("[ComboBreaker] no-cache rule", e));
    }
  });
  port.onDisconnect.addListener(() => {
    if (watchTab != null) clearNoCacheForPopupTab(watchTab).catch(() => {});
  });
});

function noCacheRuleIdForTab(tabId) {
  return NO_CACHE_SESSION_BASE + tabId;
}

async function setNoCacheForPopupTab(tabId) {
  if (tabId == null || tabId < 0) return;
  const id = noCacheRuleIdForTab(tabId);
  const rule = {
    id,
    priority: 3,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Cache-Control", operation: "set", value: "no-cache" },
        { header: "Pragma", operation: "set", value: "no-cache" },
      ],
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: HEADER_RESOURCE_TYPES,
    },
  };
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [rule],
  });
}

async function clearNoCacheForPopupTab(tabId) {
  if (tabId == null || tabId < 0) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [noCacheRuleIdForTab(tabId)],
    addRules: [],
  });
}

const VIEWPORT_UA = {
  iphone: {
    w: 375,
    h: 812,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  ipad: {
    w: 768,
    h: 1024,
    ua: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  laptop: { w: 1280, h: 720, ua: null },
  desktop: { w: 1920, h: 1080, ua: null },
  reset: { w: null, h: null, clearUa: true, ua: null },
};

function mergeRequestHeadersStrippingUa(headers) {
  return (headers || []).filter((r) => String(r.name || "").toLowerCase() !== "user-agent");
}

function requestHeadersWithOptionalUa(baseHeaders, ua) {
  const h = mergeRequestHeadersStrippingUa(baseHeaders);
  if (ua) h.push({ name: "User-Agent", op: "set", value: ua });
  return h;
}

async function setViewportPreset(tabIdOverride, preset, siteKey) {
  if (!siteKey) throw new Error("Viewport presets need a normal http(s) site (host)");
  const p = VIEWPORT_UA[preset] || null;
  if (!p) throw new Error(`Unknown viewport preset: ${preset}`);
  const tabId =
    tabIdOverride ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId == null) throw new Error("no active tab");
  const tab = await chrome.tabs.get(tabId);
  const settings = await getSite(siteKey);
  const ua = p.clearUa ? null : p.ua;
  const req = requestHeadersWithOptionalUa(settings.requestHeaders, ua);
  await setSite(siteKey, { requestHeaders: req });
  await applySiteHeaderRules(siteKey);

  if (p.w > 0 && p.h > 0) {
    try {
      await chrome.windows.update(tab.windowId, {
        width: p.w,
        height: p.h,
        focused: true,
        state: "normal",
      });
    } catch (e) {
      console.warn("[ComboBreaker] window resize", e);
    }
  }
  return { ok: true, size: p.w && p.h ? { w: p.w, h: p.h } : null, strippedUa: !!p.clearUa };
}

async function extractReaderForTab(tabIdOverride) {
  const tabId =
    tabIdOverride ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId == null || tabId < 0) throw new Error("no active tab");
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/i.test(tab.url)) {
    throw new Error("Reader and Markdown need an http(s) page");
  }
  // Chrome requires exactly one of `func` or `files` per `executeScript` call.
  // Load libraries first, then run a tiny `func` that calls `__cbRunReader`.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    files: ["vendor/Readability.js", "vendor/turndown.js", "content/reader_inject.js"],
  });
  const [{ result: out }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => {
      if (typeof globalThis === "undefined" || typeof globalThis.__cbRunReader !== "function") {
        return {
          ok: false,
          error: "Reader bootstrap missing — globalThis.__cbRunReader is not a function",
        };
      }
      return globalThis.__cbRunReader();
    },
  });
  return out;
}

async function openReaderView(tabIdOverride) {
  const r = await extractReaderForTab(tabIdOverride);
  if (!r || !r.ok) return r;
  const payload = {
    title: r.title,
    url: r.url,
    html: r.html,
    dir: r.dir || "ltr",
    lang: r.lang || "",
  };
  try {
    await chrome.storage.session.set({ [READER_SESSION_KEY]: payload });
  } catch (e) {
    throw new Error("Reader content is too large to open in a tab");
  }
  const dest = chrome.runtime.getURL("viewer/reader.html");
  await chrome.tabs.create({ url: dest, active: true });
  return { ok: true, opened: true };
}

async function listTabSessions() {
  const d = await chrome.storage.local.get(TAB_SESSIONS_KEY);
  return { sessions: d[TAB_SESSIONS_KEY] || [] };
}

async function extractStructuredDataForTab(tabIdOverride) {
  const tabId =
    tabIdOverride ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId == null || tabId < 0) throw new Error("no active tab");
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/i.test(tab.url)) {
    throw new Error("Structured data extraction requires an http(s) page");
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    files: ["content/schema_inject.js"],
  });
  const [{ result: out }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => {
      if (typeof globalThis === "undefined" || typeof globalThis.__cbExtractStructuredData !== "function") {
        return {
          ok: false,
          error: "Schema extractor missing — globalThis.__cbExtractStructuredData is not a function",
        };
      }
      return globalThis.__cbExtractStructuredData();
    },
  });
  return out;
}

async function openStructuredDataView(tabIdOverride) {
  const r = await extractStructuredDataForTab(tabIdOverride);
  if (!r || !r.ok) return r;
  const payload = {
    pageUrl: r.pageUrl,
    pageTitle: r.pageTitle,
    jsonld: r.jsonld || [],
    microdata: r.microdata || { itemscopeCount: 0, itemtypes: [] },
    rdfa: r.rdfa || { elementCount: 0, typofs: [] },
  };
  try {
    await chrome.storage.session.set({ [STRUCTURED_DATA_SESSION_KEY]: payload });
  } catch (e) {
    throw new Error("Structured data payload is too large to open in a tab");
  }
  const dest = chrome.runtime.getURL("viewer/structured_data.html");
  await chrome.tabs.create({ url: dest, active: true });
  return { ok: true, opened: true };
}

async function saveTabWindowSession(name) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const entries = tabs
    .map((t) => ({
      title: t.title || "",
      url: t.url || "",
      favIconUrl: t.favIconUrl || "",
    }))
    .filter(
      (e) =>
        e.url &&
        !e.url.startsWith("chrome://") &&
        !e.url.startsWith("edge://") &&
        !e.url.startsWith("about:") &&
        !e.url.startsWith("chrome-extension://") &&
        !e.url.startsWith("devtools://")
    );
  if (!entries.length) throw new Error("No storable tabs in this window (internal pages are skipped).");
  const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const rec = {
    id,
    name: (name && String(name).trim()) || `Window · ${new Date().toLocaleString()}`,
    saved: Date.now(),
    entries,
  };
  const cur = (await chrome.storage.local.get(TAB_SESSIONS_KEY))[TAB_SESSIONS_KEY] || [];
  const next = [rec, ...cur].slice(0, 40);
  await chrome.storage.local.set({ [TAB_SESSIONS_KEY]: next });
  return { ok: true, session: rec, total: next.length };
}

async function deleteTabSession(sessionId) {
  if (!sessionId) throw new Error("sessionId required");
  const cur = (await chrome.storage.local.get(TAB_SESSIONS_KEY))[TAB_SESSIONS_KEY] || [];
  const next = cur.filter((s) => s.id !== sessionId);
  await chrome.storage.local.set({ [TAB_SESSIONS_KEY]: next });
  return { ok: true, total: next.length };
}

async function restoreTabSession(sessionId) {
  if (!sessionId) throw new Error("sessionId required");
  const all = (await chrome.storage.local.get(TAB_SESSIONS_KEY))[TAB_SESSIONS_KEY] || [];
  const s = all.find((x) => x.id === sessionId);
  if (!s || !s.entries.length) throw new Error("Session not found");
  const urls = s.entries.map((e) => e.url).filter(Boolean);
  if (!urls.length) throw new Error("This session has no valid URLs");
  const first = await chrome.windows.create({ url: urls[0], focused: true, state: "maximized" });
  const wId = first.id;
  for (let i = 1; i < urls.length; i++) {
    await chrome.tabs.create({ windowId: wId, url: urls[i], active: false });
  }
  return { ok: true, windowId: wId, count: urls.length };
}

async function findDuplicateTabGroups() {
  const tabs = await chrome.tabs.query({});
  const m = new Map();
  for (const t of tabs) {
    const u = t.url;
    if (!u) continue;
    if (
      u.startsWith("chrome://") ||
      u.startsWith("edge://") ||
      u.startsWith("about:") ||
      u.startsWith("chrome-extension://") ||
      u.startsWith("devtools://")
    ) {
      continue;
    }
    if (!m.has(u)) m.set(u, []);
    m.get(u).push({ id: t.id, title: t.title, windowId: t.windowId, active: !!t.active });
  }
  const groups = [];
  for (const [url, list] of m) {
    if (list.length > 1) groups.push({ url, count: list.length, tabs: list });
  }
  return { groups, duplicateTabCount: groups.reduce((a, g) => a + g.count - 1, 0) };
}

async function closeDuplicateTabGroups() {
  const { groups } = await findDuplicateTabGroups();
  let closed = 0;
  for (const g of groups) {
    const keep = g.tabs.find((t) => t.active) || g.tabs[0];
    for (const t of g.tabs) {
      if (t.id === keep.id) continue;
      try {
        await chrome.tabs.remove(t.id);
        closed += 1;
      } catch (e) {
        console.warn("[ComboBreaker] close tab", e);
      }
    }
  }
  return { ok: true, closed, groupCount: groups.length };
}

// ---------- Keyboard commands ----------

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const siteKey = siteKeyFromUrl(tab.url);
  if (!siteKey) return;

  switch (command) {
    case "toggle-darkmode":
      await toggleDarkModeSite(siteKey);
      break;
    case "toggle-js": {
      const current = await getJavascriptSetting(siteKey);
      await setJsEnabled(siteKey, !current);
      chrome.tabs.reload(tab.id);
      break;
    }
    case "pick-color":
      await launchTool("color-picker", tab.id, { tab });
      break;
  }
});
