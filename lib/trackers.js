// Host -> blocklist lookup for the tracker highlighter. Built from the same
// two static rulesets the blocker uses, so "known tracker" means exactly
// "something Basic or Strong has a rule for". Pure; the service worker feeds
// it the parsed rule files.

import { ruleLabel } from "./site_rules.js";

// Map<domain, "custom" | "basic" | "strong">. When a domain is on several,
// custom wins, then basic.
export function buildTrackerIndex(basicRules, strongRules, customHosts) {
  const index = new Map();
  for (const rule of strongRules || []) {
    for (const d of (rule.condition && rule.condition.requestDomains) || []) index.set(d.toLowerCase(), "strong");
  }
  for (const rule of basicRules || []) {
    const c = rule.condition || {};
    if (typeof c.urlFilter === "string" && c.urlFilter.startsWith("||")) index.set(ruleLabel(rule).toLowerCase(), "basic");
    for (const d of c.requestDomains || []) index.set(d.toLowerCase(), "basic");
  }
  for (const d of customHosts || []) index.set(d, "custom");
  return index;
}

// Rules match a domain and all of its subdomains, so walk up the labels:
// "stats.g.doubleclick.net" -> "g.doubleclick.net" -> "doubleclick.net".
export function classifyHost(host, index) {
  let h = String(host || "").toLowerCase().replace(/\.$/, "");
  while (h.includes(".")) {
    const list = index.get(h);
    if (list) return { list, domain: h };
    h = h.slice(h.indexOf(".") + 1);
  }
  return null;
}

// No public-suffix list here: "different site" is approximated as "neither
// host is a suffix of the other", which is right for everything except
// siblings under one registrable domain (a.example.com vs b.example.com).
export function isThirdParty(host, pageHost) {
  const a = String(host || "").toLowerCase().replace(/^www\./, "");
  const b = String(pageHost || "").toLowerCase().replace(/^www\./, "");
  if (!a || !b) return false;
  return !(a === b || a.endsWith("." + b) || b.endsWith("." + a));
}

// Would the current blocker settings stop a request to this host from this page?
export function wouldBlock(hit, { level, paused, thirdParty }) {
  if (!hit || paused || level === "off") return false;
  if (hit.list === "basic") return true;
  if (hit.list === "custom") return thirdParty; // like Strong: visiting the host itself still works
  return level === "strong" && thirdParty; // Strong rules are third-party only
}

// ---- Personal blocklist ----

export const CUSTOM_BLOCK_MAX = 5000;
const CUSTOM_BLOCK_CHUNK = 500; // domains per DNR rule, same as the Strong list
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

// Accepts what people paste: a host, a URL, "*.example.com", with stray
// spaces or a trailing dot. Returns a lowercase host or null. Anything DNR
// would reject must come back null: one bad domain fails the whole rule.
export function normalizeBlockHost(input) {
  let h = String(input || "").trim().toLowerCase();
  if (!h || h.startsWith("#")) return null;
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*\./, "");
  h = h.split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  if (h.includes("@") || /\.\d+$/.test(h)) return null; // no userinfo, no IP addresses
  return HOST_RE.test(h) ? h : null;
}

// Text (one entry per line) or an array -> sorted, de-duplicated, valid hosts.
// A host already covered by a listed parent domain is dropped.
export function normalizeBlockList(input) {
  const raw = Array.isArray(input) ? input : String(input || "").split(/[\s,]+/);
  const set = new Set();
  for (const item of raw) {
    const h = normalizeBlockHost(item);
    if (h) set.add(h);
  }
  const covered = (h) => {
    let p = h.slice(h.indexOf(".") + 1);
    while (p.includes(".")) {
      if (set.has(p)) return true;
      p = p.slice(p.indexOf(".") + 1);
    }
    return false;
  };
  return [...set].filter((h) => !covered(h)).sort().slice(0, CUSTOM_BLOCK_MAX);
}

// The dynamic rules the list becomes, 500 hosts apiece, ids firstId, firstId+1…
// Third-party only, and main_frame is never included, so typing a blocked
// host into the address bar still works.
export function buildCustomBlockRules(firstId, hosts) {
  const rules = [];
  for (let i = 0; i < (hosts || []).length; i += CUSTOM_BLOCK_CHUNK) {
    rules.push({
      id: firstId + rules.length,
      priority: 1,
      action: { type: "block" },
      condition: { requestDomains: hosts.slice(i, i + CUSTOM_BLOCK_CHUNK), domainType: "thirdParty" },
    });
  }
  return rules;
}

export const CUSTOM_BLOCK_MAX_RULES = Math.ceil(CUSTOM_BLOCK_MAX / CUSTOM_BLOCK_CHUNK);

// Hosts out of a blocklist *file*: hosts format ("0.0.0.0 ads.example.com"),
// plain domain lists, and the simple domain rules of adblock lists
// ("||ads.example.com^"). Comments (#, !), exception rules (@@), cosmetic
// rules (##) and anything with a path or wildcard are skipped, since those
// say something a host block cannot. Returns raw candidates;
// normalizeBlockList validates them.
export function parseBlocklistText(text) {
  const out = [];
  for (let line of String(text || "").split(/\r?\n/)) {
    line = line.replace(/\s+#.*$/, "").trim();
    if (!line || /^[#![]/.test(line) || line.startsWith("@@") || line.includes("##") || line.includes("#@#")) continue;
    const adblock = /^\|\|([a-z0-9.-]+)\^?(?:\$third-party|\$3p)?$/i.exec(line);
    if (adblock) {
      out.push(adblock[1]);
      continue;
    }
    if (/[|^$*/]/.test(line)) continue;
    const cols = line.split(/\s+/);
    // hosts format: an address first, then one or more names
    if (cols.length > 1 && /^(\d{1,3}(\.\d{1,3}){3}|::1?|[0-9a-f:]+::[0-9a-f:]*)$/i.test(cols[0])) out.push(...cols.slice(1));
    else if (cols.length === 1) out.push(cols[0]);
  }
  return out.filter((h) => !/^(localhost|localhost\.localdomain|local|broadcasthost|ip6-[a-z-]+|0\.0\.0\.0)$/i.test(h));
}
