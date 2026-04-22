import {
  ensureSchema,
  getGlobal,
  setGlobal,
  getSite,
  setSite,
  listSites,
  effectiveDarkModeFor,
} from "../lib/storage.js";
import { siteKeyFromUrl, originPatternForSite } from "../lib/site.js";

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSchema();
  await applyAdblockState();
  await reapplyAllHeaderRules();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSchema();
  await applyAdblockState();
  await reapplyAllHeaderRules();
});

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
    case "open-hls-downloader":
      return await openHlsDownloader(msg.url, msg.title, msg.referer);
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

async function applyAdblockState() {
  const { adblockEnabled } = await getGlobal();
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    [adblockEnabled ? "enableRulesetIds" : "disableRulesetIds"]: [
      "combobreaker_basic_block",
    ],
  });
  return { adblockEnabled };
}

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

// ---------- Per-site header overrides (DNR dynamic rules) ----------
//
// We translate each site's requestHeaders / responseHeaders arrays into a
// pair of DNR dynamic rules (one for request, one for response). Stable rule
// IDs are stored in chrome.storage.local so updates can cleanly remove the
// old rules before adding the new ones.
//
// Layout in chrome.storage.local:
//   cb_header_rule_seq : number              (monotonic, never reused)
//   cb_header_rule_map : { [siteKey]: number[] }
//
// The DNR `requestDomains` condition matches the *request initiator* for
// subresources and the destination for top-level requests, which is exactly
// what "headers for site X" means.

const HEADER_VALID_OPS = new Set(["set", "append", "remove"]);
const HEADER_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
];

function sanitizeHeaderRules(rules) {
  if (!Array.isArray(rules)) return [];
  const out = [];
  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    const name = String(r.name || "").trim();
    const op = HEADER_VALID_OPS.has(r.op) ? r.op : "set";
    if (!name) continue;
    const value = op === "remove" ? "" : String(r.value ?? "");
    if (op !== "remove" && value === "") continue;
    out.push({ name, op, value });
  }
  return out;
}

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

function buildHeaderRule(id, siteKey, kind, headers) {
  // kind === "request" | "response"
  const action = {
    type: "modifyHeaders",
    [kind === "request" ? "requestHeaders" : "responseHeaders"]: headers.map((h) =>
      h.op === "remove"
        ? { header: h.name, operation: "remove" }
        : { header: h.name, operation: h.op, value: h.value }
    ),
  };
  return {
    id,
    priority: 1,
    action,
    condition: {
      requestDomains: [siteKey],
      resourceTypes: HEADER_RESOURCE_TYPES,
    },
  };
}

async function applySiteHeaderRules(siteKey) {
  if (!siteKey) return { applied: 0 };
  const settings = await getSite(siteKey);
  return await syncSiteHeaderRules(siteKey, settings);
}

async function syncSiteHeaderRules(siteKey, settings) {
  const reqHeaders = sanitizeHeaderRules(settings.requestHeaders);
  const resHeaders = sanitizeHeaderRules(settings.responseHeaders);

  const map = await getHeaderRuleMap();
  const oldIds = map[siteKey] || [];
  const newRules = [];

  if (reqHeaders.length) {
    newRules.push(buildHeaderRule(await nextHeaderRuleId(), siteKey, "request", reqHeaders));
  }
  if (resHeaders.length) {
    newRules.push(buildHeaderRule(await nextHeaderRuleId(), siteKey, "response", resHeaders));
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

  return { applied: newRules.length, requestCount: reqHeaders.length, responseCount: resHeaders.length };
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
    if (
      (settings.requestHeaders && settings.requestHeaders.length) ||
      (settings.responseHeaders && settings.responseHeaders.length)
    ) {
      await syncSiteHeaderRules(siteKey, settings);
    }
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
