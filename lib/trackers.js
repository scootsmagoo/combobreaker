// Host -> blocklist lookup for the tracker highlighter. Built from the same
// two static rulesets the blocker uses, so "known tracker" means exactly
// "something Basic or Strong has a rule for". Pure; the service worker feeds
// it the parsed rule files.

import { ruleLabel } from "./site_rules.js";

// Map<domain, "basic" | "strong">. Basic wins when a domain is on both.
export function buildTrackerIndex(basicRules, strongRules) {
  const index = new Map();
  for (const rule of strongRules || []) {
    for (const d of (rule.condition && rule.condition.requestDomains) || []) index.set(d.toLowerCase(), "strong");
  }
  for (const rule of basicRules || []) {
    const c = rule.condition || {};
    if (typeof c.urlFilter === "string" && c.urlFilter.startsWith("||")) index.set(ruleLabel(rule).toLowerCase(), "basic");
    for (const d of c.requestDomains || []) index.set(d.toLowerCase(), "basic");
  }
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
  return level === "strong" && thirdParty; // Strong rules are third-party only
}
