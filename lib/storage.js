// Thin wrapper around chrome.storage.sync with a versioned schema.
// Layout (all keys live in chrome.storage.sync):
//   schema_version : number
//   global         : GlobalSettings
//   site:<host>    : SiteSettings minus css/js (one item per site)
// and in chrome.storage.local (sync's ~8 KB per-item cap is too small for code):
//   sitecode:<host>: { css: string, js: string }
//
// GlobalSettings = {
//   jsonFormatterEnabled: boolean,
//   adblockLevel:         "off" | "basic" | "strong",
//   adblockEnabled:       boolean,   // derived: adblockLevel !== "off" (pre-0.5 field)
//   adblockBadge:         boolean,   // show the per-tab blocked count on the toolbar icon
//   linkSelect:           { enabled, trigger, action, copyFormat, smart }, see lib/links.js
//   darkMode: {
//     enabled: boolean,            // global on/off; per-site override can flip
//     detectDark: boolean,         // Auto leaves sites alone that are dark already
//     theme: {
//       brightness: number,        // 0–200, default 100
//       contrast:   number,        // 0–200, default 100
//       sepia:      number,        // 0–100, default 0
//       grayscale:  number,        // 0–100, default 0
//       mode:       0 | 1,         // 0 = light theme, 1 = dark theme
//     },
//   },
// }
//
// SiteSettings = {
//   css:             string,
//   cssEnabled:      boolean,
//   js:              string,
//   jsEnabled:       boolean,
//   darkMode:        "on" | "off" | null,   // null = inherit from global
//   adblockPaused:   boolean,               // DNR allowAllRequests rule, see service worker
//   requestHeaders:  HeaderRule[],          // applied via DNR dynamic rules
//   responseHeaders: HeaderRule[],          // applied via DNR dynamic rules
//   autoClear:       boolean,               // nuke site data when its last tab closes
//   blockThirdPartyCookies: boolean,        // DNR cookie/set-cookie strip, see lib/site_rules.js
//   referrerPolicy:  "" | "strict-origin-when-cross-origin" | "same-origin" | "no-referrer",
// }
//
// HeaderRule = { name: string, op: "set" | "append" | "remove", value: string }
//
// chrome.storage.sync has a per-item quota (~8 KB) and total quota (~100 KB).

import { DEFAULT_LINK_SELECT, mergeLinkSelect } from "./links.js";

const SCHEMA_VERSION = 4;

const DEFAULT_DARK_THEME = {
  brightness: 100,
  contrast: 100,
  sepia: 0,
  grayscale: 0,
  mode: 1,
};

// yt-dlp bridge settings (see native/README.md). Empty strings mean
// "let the native host auto-detect".
const DEFAULT_YTDLP = {
  outputDir: "",           // default: ~/Downloads/combobreaker
  ytdlpPath: "",           // path to yt-dlp(.exe) or its folder
  ffmpegPath: "",          // path to ffmpeg(.exe) or its folder
  preferMp4: true,         // -S res,ext:mp4:m4a --merge-output-format mp4
  extraArgs: "",           // appended verbatim (shell-style split)
  cookiesFromBrowser: "",  // e.g. "chrome" -> --cookies-from-browser chrome (advanced)
  sendCookies: false,      // export this browser's cookies for the video's site per download
  quality: "best",         // default preset for one-click downloads
};

const DEFAULT_GLOBAL = {
  jsonFormatterEnabled: true,
  adblockLevel: "basic",
  adblockEnabled: true,
  adblockBadge: true, // blocked-request count on the toolbar icon
  mediaOverlayEnabled: true, // on-page download badges (per-site override below)
  darkMode: {
    enabled: false,
    detectDark: true,
    theme: { ...DEFAULT_DARK_THEME },
  },
  ytdlp: { ...DEFAULT_YTDLP },
  linkSelect: { ...DEFAULT_LINK_SELECT },
};

const DEFAULT_SITE = {
  css: "",
  cssEnabled: false,
  js: "",
  jsEnabled: false,
  darkMode: null,
  mediaOverlay: null, // true | false | null = inherit global.mediaOverlayEnabled
  adblockPaused: false, // true = no ad/tracker blocking while this site is the top page
  requestHeaders: [],
  responseHeaders: [],
  autoClear: false, // true = cookies + storage are wiped when the site's last tab closes
  blockThirdPartyCookies: false,
  referrerPolicy: "", // "" = leave the site's own policy alone
};

export const ADBLOCK_LEVELS = ["off", "basic", "strong"];

function siteItemKey(siteKey) {
  return `site:${siteKey}`;
}

function siteCodeKey(siteKey) {
  return `sitecode:${siteKey}`;
}

function mergeGlobal(raw) {
  const g = { ...DEFAULT_GLOBAL, ...(raw || {}) };
  const dm = g.darkMode || {};
  g.darkMode = {
    enabled: !!dm.enabled,
    detectDark: dm.detectDark !== false,
    theme: { ...DEFAULT_DARK_THEME, ...(dm.theme || {}) },
  };
  g.ytdlp = { ...DEFAULT_YTDLP, ...(g.ytdlp || {}) };
  g.mediaOverlayEnabled = g.mediaOverlayEnabled !== false;
  g.adblockBadge = g.adblockBadge !== false;
  g.linkSelect = mergeLinkSelect(g.linkSelect);
  // adblockLevel replaced the adblockEnabled boolean; settings saved before
  // that (and old backups) only have the boolean.
  const rawLevel = raw && raw.adblockLevel;
  g.adblockLevel = ADBLOCK_LEVELS.includes(rawLevel)
    ? rawLevel
    : raw && raw.adblockEnabled === false
      ? "off"
      : "basic";
  g.adblockEnabled = g.adblockLevel !== "off";
  return g;
}

export async function getGlobal() {
  const { global } = await chrome.storage.sync.get("global");
  return mergeGlobal(global);
}

export async function setGlobal(patch) {
  const current = await getGlobal();
  // Callers that still speak the old boolean.
  if (patch && "adblockEnabled" in patch && !("adblockLevel" in patch)) {
    patch = { ...patch, adblockLevel: patch.adblockEnabled ? (current.adblockEnabled ? current.adblockLevel : "basic") : "off" };
  }
  const next = mergeGlobal({ ...current, ...patch });
  if (patch && patch.darkMode) {
    next.darkMode = {
      enabled:
        patch.darkMode.enabled != null ? !!patch.darkMode.enabled : current.darkMode.enabled,
      detectDark:
        patch.darkMode.detectDark != null ? !!patch.darkMode.detectDark : current.darkMode.detectDark,
      theme: {
        ...current.darkMode.theme,
        ...(patch.darkMode.theme || {}),
      },
    };
  }
  if (patch && patch.ytdlp) {
    next.ytdlp = { ...current.ytdlp, ...patch.ytdlp };
  }
  if (patch && patch.linkSelect) {
    next.linkSelect = mergeLinkSelect({ ...current.linkSelect, ...patch.linkSelect });
  }
  await chrome.storage.sync.set({ global: next });
  return next;
}

function mergeSite(raw) {
  const s = { ...DEFAULT_SITE, ...(raw || {}) };
  s.requestHeaders = Array.isArray(s.requestHeaders) ? s.requestHeaders : [];
  s.responseHeaders = Array.isArray(s.responseHeaders) ? s.responseHeaders : [];
  return s;
}

// Split a full SiteSettings into the small synced part and the (potentially
// large) code bodies that live in chrome.storage.local.
export function splitSite(full) {
  const { css, js, ...meta } = full;
  return { meta, code: { css: css || "", js: js || "" } };
}

export function isSiteEmpty(s) {
  return (
    !s.css &&
    !s.cssEnabled &&
    !s.js &&
    !s.jsEnabled &&
    s.darkMode == null &&
    s.mediaOverlay == null &&
    !s.adblockPaused &&
    !s.autoClear &&
    !s.blockThirdPartyCookies &&
    !s.referrerPolicy &&
    s.requestHeaders.length === 0 &&
    s.responseHeaders.length === 0
  );
}

export async function getSite(siteKey) {
  if (!siteKey) return { ...DEFAULT_SITE };
  const key = siteItemKey(siteKey);
  const codeKey = siteCodeKey(siteKey);
  const [meta, code] = await Promise.all([
    chrome.storage.sync.get(key),
    chrome.storage.local.get(codeKey),
  ]);
  return mergeSite({ ...(meta[key] || {}), ...(code[codeKey] || {}) });
}

export async function setSite(siteKey, patch) {
  if (!siteKey) throw new Error("siteKey required");
  const current = await getSite(siteKey);
  const next = mergeSite({ ...current, ...patch });
  const key = siteItemKey(siteKey);
  const codeKey = siteCodeKey(siteKey);
  if (isSiteEmpty(next)) {
    await Promise.all([chrome.storage.sync.remove(key), chrome.storage.local.remove(codeKey)]);
    return next;
  }
  const { meta, code } = splitSite(next);
  // Code first: the content script reloads on the sync change and must see
  // the new body when it does.
  if (code.css || code.js) await chrome.storage.local.set({ [codeKey]: code });
  else await chrome.storage.local.remove(codeKey);
  await chrome.storage.sync.set({ [key]: meta });
  return next;
}

export async function listSites() {
  const [all, local] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get(null),
  ]);
  const keys = new Set();
  for (const k of Object.keys(all)) if (k.startsWith("site:")) keys.add(k.slice(5));
  for (const k of Object.keys(local)) if (k.startsWith("sitecode:")) keys.add(k.slice(9));
  const out = [];
  for (const siteKey of keys) {
    out.push({
      siteKey,
      settings: mergeSite({
        ...(all[siteItemKey(siteKey)] || {}),
        ...(local[siteCodeKey(siteKey)] || {}),
      }),
    });
  }
  out.sort((a, b) => a.siteKey.localeCompare(b.siteKey));
  return out;
}

export async function deleteSite(siteKey) {
  if (!siteKey) return;
  await Promise.all([
    chrome.storage.sync.remove(siteItemKey(siteKey)),
    chrome.storage.local.remove(siteCodeKey(siteKey)),
  ]);
}

// storage.local key where content/site_injector.js caches what Auto measured:
// { [siteKey]: { dark: boolean, at: ms } }
export const DARK_DETECT_KEY = "cb_dark_detect";

// Resolves the effective dark-mode state for a given site.
// Per-site override wins; "null" falls back to the global toggle.
export function effectiveDarkModeFor(globalSettings, siteSettings) {
  const override = siteSettings && siteSettings.darkMode;
  if (override === "on") return true;
  if (override === "off") return false;
  return !!(globalSettings && globalSettings.darkMode && globalSettings.darkMode.enabled);
}

// Migrate from older schemas. Idempotent.
export async function ensureSchema() {
  const all = await chrome.storage.sync.get(null);
  const current = all.schema_version || 0;
  if (current === SCHEMA_VERSION) return;

  const writes = {};
  const removes = [];

  // v0/v1 → v2
  if (current < 2) {
    const oldGlobal = all.global || {};
    const newGlobal = mergeGlobal({
      ...oldGlobal,
      darkMode: {
        // v1 stored a bare boolean as `defaultDarkMode`.
        enabled: !!oldGlobal.defaultDarkMode,
        theme: { ...DEFAULT_DARK_THEME },
      },
    });
    delete newGlobal.defaultDarkMode;
    writes.global = newGlobal;

    // Per-site darkMode: boolean | null  →  "on" | "off" | null
    for (const k of Object.keys(all)) {
      if (!k.startsWith("site:")) continue;
      const s = { ...DEFAULT_SITE, ...(all[k] || {}) };
      let migrated;
      if (s.darkMode === true) migrated = "on";
      else if (s.darkMode === false) migrated = "off";
      else migrated = null;
      const next = { ...s, darkMode: migrated };
      const isEmpty =
        !next.css &&
        !next.cssEnabled &&
        !next.js &&
        !next.jsEnabled &&
        next.darkMode == null;
      if (isEmpty) removes.push(k);
      else writes[k] = next;
    }
  }

  // v2 → v3: per-site header overrides arrays. Ensure existing site entries
  // have requestHeaders / responseHeaders arrays so older clients don't write
  // them back as undefined.
  if (current < 3) {
    for (const k of Object.keys(all)) {
      if (!k.startsWith("site:")) continue;
      // If we already touched this key in the v0/v1→v2 step it's in `writes`;
      // otherwise pull the raw entry.
      const base = writes[k] || all[k] || {};
      writes[k] = mergeSite(base);
    }
  }

  // v3 → v4: css/js bodies move out of sync (8 KB per-item cap) into
  // chrome.storage.local under sitecode:<host>.
  if (current < 4) {
    const localWrites = {};
    for (const k of Object.keys(all)) {
      if (!k.startsWith("site:") || removes.includes(k)) continue;
      const { meta, code } = splitSite(mergeSite(writes[k] || all[k] || {}));
      if (code.css || code.js) localWrites[siteCodeKey(k.slice(5))] = code;
      writes[k] = meta;
    }
    // Local first so a failure here leaves the sync copy untouched.
    if (Object.keys(localWrites).length) await chrome.storage.local.set(localWrites);
  }

  writes.schema_version = SCHEMA_VERSION;
  if (Object.keys(writes).length) await chrome.storage.sync.set(writes);
  if (removes.length) await chrome.storage.sync.remove(removes);
}

export { DEFAULT_GLOBAL, DEFAULT_SITE, DEFAULT_DARK_THEME, DEFAULT_YTDLP };
