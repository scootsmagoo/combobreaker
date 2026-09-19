// Browse tab: reader view, structured data, viewport presets, tab sessions, duplicates, no-cache.

import { HEADER_RESOURCE_TYPES } from "../lib/site_rules.js";
import { getSite, setSite } from "../lib/storage.js";
import { applySiteHeaderRules } from "./header_rules.js";

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

export async function setViewportPreset(tabIdOverride, preset, siteKey) {
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

export async function extractReaderForTab(tabIdOverride) {
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

export async function openReaderView(tabIdOverride) {
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

export async function listTabSessions() {
  const d = await chrome.storage.local.get(TAB_SESSIONS_KEY);
  return { sessions: d[TAB_SESSIONS_KEY] || [] };
}

export async function extractStructuredDataForTab(tabIdOverride) {
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

export async function openStructuredDataView(tabIdOverride) {
  const r = await extractStructuredDataForTab(tabIdOverride);
  if (!r || !r.ok) return r;
  const payload = {
    pageUrl: r.pageUrl,
    pageTitle: r.pageTitle,
    jsonld: r.jsonld || [],
    microdata: r.microdata || { itemscopeCount: 0, itemtypes: [] },
    rdfa: r.rdfa || { elementCount: 0, typofs: [] },
    meta: r.meta || null,
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

export async function saveTabWindowSession(name) {
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

export async function deleteTabSession(sessionId) {
  if (!sessionId) throw new Error("sessionId required");
  const cur = (await chrome.storage.local.get(TAB_SESSIONS_KEY))[TAB_SESSIONS_KEY] || [];
  const next = cur.filter((s) => s.id !== sessionId);
  await chrome.storage.local.set({ [TAB_SESSIONS_KEY]: next });
  return { ok: true, total: next.length };
}

export async function restoreTabSession(sessionId) {
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

export async function findDuplicateTabGroups() {
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

export async function closeDuplicateTabGroups() {
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
