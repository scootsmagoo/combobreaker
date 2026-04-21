// Thin wrapper around chrome.storage.sync with a versioned schema.
// Layout (all keys live in chrome.storage.sync):
//   schema_version   : number
//   global           : { kagiEnabled, defaultDarkMode, jsonFormatterEnabled, adblockEnabled }
//   sites            : { [siteKey]: SiteSettings }
//
// SiteSettings = {
//   css:        string,        // user CSS injected at document_start
//   cssEnabled: boolean,
//   js:         string,        // user JS injected in MAIN world
//   jsEnabled:  boolean,
//   darkMode:   boolean,       // overrides global default if set
// }
//
// chrome.storage.sync has a per-item quota (~8 KB) and total quota (~100 KB).
// We store one item per site to stay under the per-item limit on big CSS blobs.

const SCHEMA_VERSION = 1;

const DEFAULT_GLOBAL = {
  kagiEnabled: true,
  defaultDarkMode: false,
  jsonFormatterEnabled: true,
  adblockEnabled: true,
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

export async function getGlobal() {
  const { global } = await chrome.storage.sync.get("global");
  return { ...DEFAULT_GLOBAL, ...(global || {}) };
}

export async function setGlobal(patch) {
  const current = await getGlobal();
  const next = { ...current, ...patch };
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

export async function ensureSchema() {
  const { schema_version } = await chrome.storage.sync.get("schema_version");
  if (schema_version !== SCHEMA_VERSION) {
    await chrome.storage.sync.set({ schema_version: SCHEMA_VERSION });
  }
}

export { DEFAULT_GLOBAL, DEFAULT_SITE };
