// Ad & tracker blocking: ruleset levels, per-site pause, blocked summary, tracker classification.

import { siteKeyFromUrl } from "../lib/site.js";
import { ruleLabel } from "../lib/site_rules.js";
import { getGlobal, getSite, listSites } from "../lib/storage.js";
import {
  buildTrackerIndex,
  classifyHost,
  isThirdParty,
  wouldBlock,
  normalizeBlockHost,
  normalizeBlockList,
  buildCustomBlockRules,
  parseBlocklistText,
  CUSTOM_BLOCK_MAX_RULES,
} from "../lib/trackers.js";

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
const CUSTOM_BLOCK_RULE_ID = 900002; // first of up to CUSTOM_BLOCK_MAX_RULES consecutive ids
// storage.local (and Backup): string[] of hosts, see "Personal blocklist" below.
const CUSTOM_BLOCK_KEY = "cb_custom_block";

export async function applyAdblockState() {
  const { adblockLevel, adblockBadge } = await getGlobal();
  const want = adblockLevel === "strong" ? ["basic", "strong"] : adblockLevel === "basic" ? ["basic"] : [];
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: want.map((k) => ADBLOCK_RULESETS[k]),
    disableRulesetIds: Object.keys(ADBLOCK_RULESETS)
      .filter((k) => !want.includes(k))
      .map((k) => ADBLOCK_RULESETS[k]),
  });
  // Chrome keeps the per-tab count itself. It counts every request a rule
  // acted on, so header overrides and the cookie/referrer rules add to it.
  await chrome.declarativeNetRequest.setExtensionActionOptions({
    displayActionCountAsBadgeText: adblockBadge && adblockLevel !== "off",
  });
  chrome.action.setBadgeBackgroundColor({ color: "#475569" }).catch(() => {});
  await applyCustomBlockRule(adblockLevel);
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

// What was blocked on one tab since its last navigation, for the popup. Basic
// has one rule per company, so those can be named; Strong packs hundreds of
// domains into each rule, so it only gets a count. getMatchedRules is rate
// limited (20 calls / 10 min); the popup treats a failure as "no data".

let basicRuleNames = null;

async function loadBasicRuleNames() {
  if (basicRuleNames) return basicRuleNames;
  const rules = await (await fetch(chrome.runtime.getURL("rules/basic_block.json"))).json();
  basicRuleNames = new Map(rules.map((r) => [r.id, ruleLabel(r)]));
  return basicRuleNames;
}

export async function adblockMatched(tabId) {
  if (tabId == null || tabId < 0) return null;
  const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
  const names = await loadBasicRuleNames();
  const byName = new Map();
  let strong = 0;
  let custom = 0;
  for (const { rule } of rulesMatchedInfo) {
    if (rule.rulesetId === ADBLOCK_RULESETS.strong) strong++;
    else if (rule.rulesetId === "_dynamic" && rule.ruleId >= CUSTOM_BLOCK_RULE_ID && rule.ruleId < CUSTOM_BLOCK_RULE_ID + CUSTOM_BLOCK_MAX_RULES) custom++;
    else if (rule.rulesetId === ADBLOCK_RULESETS.basic) {
      const name = names.get(rule.ruleId) || `rule ${rule.ruleId}`;
      byName.set(name, (byName.get(name) || 0) + 1);
    }
  }
  const basic = [...byName].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return { total: strong + custom + basic.reduce((n, b) => n + b.count, 0), basic, strong, custom };
}

// ---------- Personal blocklist ----------
//
// Hosts the user added (tracker highlighter's "Block" button, or the list in
// options). One dynamic block rule, third-party only like Strong, active at
// every level except Off and lifted by per-site pause like the static lists.

export async function getCustomBlock() {
  const data = await chrome.storage.local.get(CUSTOM_BLOCK_KEY);
  return normalizeBlockList(data[CUSTOM_BLOCK_KEY] || []);
}

async function applyCustomBlockRule(level) {
  trackerIndex = null; // the list may have changed underneath (backup import)
  const addRules = level === "off" ? [] : buildCustomBlockRules(CUSTOM_BLOCK_RULE_ID, await getCustomBlock());
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: Array.from({ length: CUSTOM_BLOCK_MAX_RULES }, (_, i) => CUSTOM_BLOCK_RULE_ID + i),
    addRules,
  });
}

export async function setCustomBlock(input) {
  const hosts = normalizeBlockList(input);
  await chrome.storage.local.set({ [CUSTOM_BLOCK_KEY]: hosts });
  trackerIndex = null;
  await applyCustomBlockRule((await getGlobal()).adblockLevel);
  return { hosts };
}

// Options → Import file: hosts files, domain lists, simple adblock rules.
// Merged into the existing list; the counts let the page say what happened.
export async function importCustomBlock(text) {
  const before = await getCustomBlock();
  const found = normalizeBlockList(parseBlocklistText(text));
  const { hosts } = await setCustomBlock([...before, ...found]);
  return { hosts, found: found.length, added: hosts.length - before.length };
}

// From a page (the highlighter): never the page's own site, that is what
// "Pause" and the JS toggle are for, and third-party-only would ignore it anyway.
export async function addCustomBlock(host, pageUrl) {
  const h = normalizeBlockHost(host);
  if (!h) throw new Error("not a valid host name");
  const siteKey = siteKeyFromUrl(pageUrl);
  if (siteKey && siteKey !== "file://" && !isThirdParty(h, siteKey)) throw new Error("that is this site itself");
  return await setCustomBlock([...(await getCustomBlock()), h]);
}

// For tools/trackers.js: which of the hosts a page talks to are on the Basic
// or Strong list, and whether the current settings would block them there.

let trackerIndex = null;

async function loadTrackerIndex() {
  if (trackerIndex) return trackerIndex;
  const load = async (file) => (await fetch(chrome.runtime.getURL(file))).json();
  trackerIndex = buildTrackerIndex(
    await load("rules/basic_block.json"),
    await load("rules/strong_block.json"),
    await getCustomBlock()
  );
  return trackerIndex;
}

export async function classifyTrackers(hosts, pageUrl) {
  const index = await loadTrackerIndex();
  const siteKey = siteKeyFromUrl(pageUrl);
  const [{ adblockLevel }, site] = await Promise.all([getGlobal(), getSite(siteKey)]);
  const out = {};
  for (const host of (Array.isArray(hosts) ? hosts : []).slice(0, 500)) {
    const hit = classifyHost(host, index);
    if (!hit) continue;
    const thirdParty = isThirdParty(host, siteKey);
    out[host] = { ...hit, blocked: wouldBlock(hit, { level: adblockLevel, paused: !!site.adblockPaused, thirdParty }) };
  }
  return { hosts: out, level: adblockLevel, paused: !!site.adblockPaused };
}
