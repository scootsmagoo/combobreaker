// Settings export / import. Everything ComboBreaker persists that is worth
// keeping: global settings, per-site settings (including css/js bodies, which
// live in storage.local and therefore never sync), snippets and saved tab
// sessions. Plain JSON, no network.

import { getGlobal, setGlobal, listSites, setSite, DEFAULT_SITE } from "./storage.js";

export const BACKUP_FORMAT = 1;
const LOCAL_KEYS = ["cb_tab_sessions", "cb_snippets"];
const HOST_RE = /^(file:\/\/|[a-z0-9.-]+)$/i;

export async function exportAll() {
  const [global, sites, local] = await Promise.all([
    getGlobal(),
    listSites(),
    chrome.storage.local.get(LOCAL_KEYS),
  ]);
  return {
    app: "combobreaker",
    format: BACKUP_FORMAT,
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    global,
    sites: Object.fromEntries(sites.map((s) => [s.siteKey, s.settings])),
    local,
  };
}

// Pure: validates and strips a parsed backup down to known fields. Throws on
// anything that is not a ComboBreaker backup.
export function normalizeBackup(data) {
  if (!data || typeof data !== "object" || data.app !== "combobreaker") {
    throw new Error("Not a ComboBreaker backup file");
  }
  if (typeof data.format !== "number" || data.format > BACKUP_FORMAT) {
    throw new Error(`Backup format ${data.format} is newer than this version understands`);
  }
  const sites = {};
  for (const [host, raw] of Object.entries(data.sites || {})) {
    if (!HOST_RE.test(host) || !raw || typeof raw !== "object") continue;
    const clean = {};
    for (const k of Object.keys(DEFAULT_SITE)) if (k in raw) clean[k] = raw[k];
    sites[host.toLowerCase()] = clean;
  }
  const local = {};
  for (const k of LOCAL_KEYS) {
    if (data.local && Array.isArray(data.local[k])) local[k] = data.local[k];
  }
  const global = data.global && typeof data.global === "object" ? data.global : null;
  return { global, sites, local };
}

// Merge semantics: sites in the file overwrite same-named sites; others are
// left alone.
export async function importAll(data) {
  const { global, sites, local } = normalizeBackup(data);
  if (global) await setGlobal(global);
  for (const [host, settings] of Object.entries(sites)) {
    await setSite(host, { ...DEFAULT_SITE, ...settings });
  }
  if (Object.keys(local).length) await chrome.storage.local.set(local);
  return { sites: Object.keys(sites) };
}
