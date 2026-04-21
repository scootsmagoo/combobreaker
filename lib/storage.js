// Thin wrapper around chrome.storage.sync with a versioned schema.
// Layout (all keys live in chrome.storage.sync):
//   schema_version : number
//   global         : GlobalSettings
//   site:<host>    : SiteSettings   (one item per site, to dodge per-item quota)
//
// GlobalSettings = {
//   kagiEnabled:          boolean,
//   jsonFormatterEnabled: boolean,
//   adblockEnabled:       boolean,
//   darkMode: {
//     enabled: boolean,            // global on/off; per-site override can flip
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
//   css:        string,
//   cssEnabled: boolean,
//   js:         string,
//   jsEnabled:  boolean,
//   darkMode:   "on" | "off" | null,   // null = inherit from global
// }
//
// chrome.storage.sync has a per-item quota (~8 KB) and total quota (~100 KB).

const SCHEMA_VERSION = 2;

const DEFAULT_DARK_THEME = {
  brightness: 100,
  contrast: 100,
  sepia: 0,
  grayscale: 0,
  mode: 1,
};

const DEFAULT_GLOBAL = {
  kagiEnabled: true,
  jsonFormatterEnabled: true,
  adblockEnabled: true,
  darkMode: {
    enabled: false,
    theme: { ...DEFAULT_DARK_THEME },
  },
};

const DEFAULT_SITE = {
  css: "",
  cssEnabled: false,
  js: "",
  jsEnabled: false,
  darkMode: null,
};

function siteItemKey(siteKey) {
  return `site:${siteKey}`;
}

function mergeGlobal(raw) {
  const g = { ...DEFAULT_GLOBAL, ...(raw || {}) };
  const dm = g.darkMode || {};
  g.darkMode = {
    enabled: !!dm.enabled,
    theme: { ...DEFAULT_DARK_THEME, ...(dm.theme || {}) },
  };
  return g;
}

export async function getGlobal() {
  const { global } = await chrome.storage.sync.get("global");
  return mergeGlobal(global);
}

export async function setGlobal(patch) {
  const current = await getGlobal();
  const next = mergeGlobal({ ...current, ...patch });
  if (patch && patch.darkMode) {
    next.darkMode = {
      enabled:
        patch.darkMode.enabled != null ? !!patch.darkMode.enabled : current.darkMode.enabled,
      theme: {
        ...current.darkMode.theme,
        ...(patch.darkMode.theme || {}),
      },
    };
  }
  await chrome.storage.sync.set({ global: next });
  return next;
}

export async function getSite(siteKey) {
  if (!siteKey) return { ...DEFAULT_SITE };
  const key = siteItemKey(siteKey);
  const out = await chrome.storage.sync.get(key);
  return { ...DEFAULT_SITE, ...(out[key] || {}) };
}

export async function setSite(siteKey, patch) {
  if (!siteKey) throw new Error("siteKey required");
  const current = await getSite(siteKey);
  const next = { ...current, ...patch };
  const isEmpty =
    !next.css &&
    !next.cssEnabled &&
    !next.js &&
    !next.jsEnabled &&
    next.darkMode == null;
  const key = siteItemKey(siteKey);
  if (isEmpty) {
    await chrome.storage.sync.remove(key);
  } else {
    await chrome.storage.sync.set({ [key]: next });
  }
  return next;
}

export async function listSites() {
  const all = await chrome.storage.sync.get(null);
  const out = [];
  for (const k of Object.keys(all)) {
    if (k.startsWith("site:")) {
      out.push({ siteKey: k.slice(5), settings: { ...DEFAULT_SITE, ...all[k] } });
    }
  }
  out.sort((a, b) => a.siteKey.localeCompare(b.siteKey));
  return out;
}

export async function deleteSite(siteKey) {
  if (!siteKey) return;
  await chrome.storage.sync.remove(siteItemKey(siteKey));
}

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

  writes.schema_version = SCHEMA_VERSION;
  if (Object.keys(writes).length) await chrome.storage.sync.set(writes);
  if (removes.length) await chrome.storage.sync.remove(removes);
}

export { DEFAULT_GLOBAL, DEFAULT_SITE, DEFAULT_DARK_THEME };
