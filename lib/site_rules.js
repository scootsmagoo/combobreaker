// Pure builders for the per-site declarativeNetRequest dynamic rules: header
// overrides, third-party cookie stripping and the referrer override. No chrome.*
// in here so node:test can cover it; the service worker assigns rule ids and
// installs the result.

const HEADER_VALID_OPS = new Set(["set", "append", "remove"]);

export const HEADER_RESOURCE_TYPES = [
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

const SUBRESOURCE_TYPES = HEADER_RESOURCE_TYPES.filter((t) => t !== "main_frame");

// Above ADBLOCK_PAUSE_PRIORITY (2), or a paused site would lose these rules:
// an allow rule cancels modifyHeaders rules of equal or lower priority.
export const SITE_RULE_PRIORITY = 3;

// "" = leave the site's own policy alone. Chrome's default is already
// strict-origin-when-cross-origin; forcing it only matters on sites that
// loosen it (unsafe-url, no-referrer-when-downgrade).
export const REFERRER_POLICIES = ["", "strict-origin-when-cross-origin", "same-origin", "no-referrer"];

export function sanitizeHeaderRules(rules) {
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

export function normalizeReferrerPolicy(value) {
  return REFERRER_POLICIES.includes(value) ? value : "";
}

function headerOverrideRule(siteKey, kind, headers) {
  // kind === "request" | "response"
  return {
    priority: SITE_RULE_PRIORITY,
    action: {
      type: "modifyHeaders",
      [kind === "request" ? "requestHeaders" : "responseHeaders"]: headers.map((h) =>
        h.op === "remove"
          ? { header: h.name, operation: "remove" }
          : { header: h.name, operation: h.op, value: h.value }
      ),
    },
    condition: { requestDomains: [siteKey], resourceTypes: HEADER_RESOURCE_TYPES },
  };
}

// Requests this site's pages make to other registrable domains go out without
// cookies and cannot set any. main_frame is left alone: following a link from
// here to another site must not log you out over there. Requests made from
// inside a third-party iframe have that iframe as initiator and are not
// covered (the iframe's own document request is).
function thirdPartyCookieRule(siteKey) {
  return {
    priority: SITE_RULE_PRIORITY,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "cookie", operation: "remove" }],
      responseHeaders: [{ header: "set-cookie", operation: "remove" }],
    },
    condition: { initiatorDomains: [siteKey], domainType: "thirdParty", resourceTypes: SUBRESOURCE_TYPES },
  };
}

// Two halves: a Referrer-Policy response header on the site's documents (also
// governs document.referrer in embeds), and for the strict policies a Referer
// request-header strip, because a <meta name="referrer"> or referrerpolicy=""
// attribute in the page can override the response header.
function referrerRules(siteKey, policy) {
  const rules = [
    {
      priority: SITE_RULE_PRIORITY,
      action: {
        type: "modifyHeaders",
        responseHeaders: [{ header: "referrer-policy", operation: "set", value: policy }],
      },
      condition: { requestDomains: [siteKey], resourceTypes: ["main_frame", "sub_frame"] },
    },
  ];
  if (policy === "same-origin" || policy === "no-referrer") {
    const condition = { initiatorDomains: [siteKey], resourceTypes: HEADER_RESOURCE_TYPES };
    if (policy === "same-origin") condition.domainType = "thirdParty";
    rules.push({
      priority: SITE_RULE_PRIORITY,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "remove" }] },
      condition,
    });
  }
  return rules;
}

export function siteNeedsRules(settings) {
  if (!settings) return false;
  return !!(
    (settings.requestHeaders && settings.requestHeaders.length) ||
    (settings.responseHeaders && settings.responseHeaders.length) ||
    settings.blockThirdPartyCookies ||
    normalizeReferrerPolicy(settings.referrerPolicy)
  );
}

// Returns DNR rules without ids.
export function buildSiteRules(siteKey, settings) {
  if (!siteKey || siteKey === "file://" || !settings) return [];
  const rules = [];
  const reqHeaders = sanitizeHeaderRules(settings.requestHeaders);
  const resHeaders = sanitizeHeaderRules(settings.responseHeaders);
  if (reqHeaders.length) rules.push(headerOverrideRule(siteKey, "request", reqHeaders));
  if (resHeaders.length) rules.push(headerOverrideRule(siteKey, "response", resHeaders));
  if (settings.blockThirdPartyCookies) rules.push(thirdPartyCookieRule(siteKey));
  const policy = normalizeReferrerPolicy(settings.referrerPolicy);
  if (policy) rules.push(...referrerRules(siteKey, policy));
  return rules;
}
