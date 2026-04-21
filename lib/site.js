// Helpers for normalizing URLs into the "site key" we store settings under.
// A site key is the registrable hostname stripped of leading "www.".
// Example: https://www.news.ycombinator.com/item?id=1 -> "news.ycombinator.com"

export function siteKeyFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) && u.protocol !== "file:") return null;
    if (u.protocol === "file:") return "file://";
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host || null;
  } catch {
    return null;
  }
}

export function urlPatternForSite(siteKey) {
  if (!siteKey) return null;
  if (siteKey === "file://") return "file:///*";
  return `*://*.${siteKey}/*`;
}

export function originPatternForSite(siteKey) {
  if (!siteKey || siteKey === "file://") return null;
  return `*://${siteKey}/*`;
}

export function prettySite(siteKey) {
  if (!siteKey) return "(unknown site)";
  return siteKey;
}
