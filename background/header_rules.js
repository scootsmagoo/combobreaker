// Per-site DNR dynamic rules (header overrides, cookie strip, referrer).

import { buildSiteRules, siteNeedsRules } from "../lib/site_rules.js";
import { getSite, listSites } from "../lib/storage.js";

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

export async function applySiteHeaderRules(siteKey) {
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

export async function reapplyAllHeaderRules() {
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
