// Link select (the Linkclump-style "drag a box over links" tool): the parts
// that do not need a page. content/link_select.js collects { url, text } for
// the links in the box; the service worker cleans, caps and formats them here.

export const LINK_ACTIONS = ["tabs", "window", "copy"];
export const LINK_TRIGGERS = ["z", "shift", "alt", "right"];
export const LINK_COPY_FORMATS = ["urls", "titles", "markdown"];
export const LINKS_CONFIRM_ABOVE = 25; // the page asks before opening more than this
export const LINKS_MAX_OPEN = 100; // hard cap, whatever was confirmed

export const DEFAULT_LINK_SELECT = {
  enabled: true,
  trigger: "z", // hold Z (or Shift / Alt) and drag, or drag with the right button
  action: "tabs",
  copyFormat: "urls",
  smart: true, // when headline links are in the box, take only those
};

export function mergeLinkSelect(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  return {
    enabled: r.enabled !== false,
    trigger: pick(r.trigger, LINK_TRIGGERS, DEFAULT_LINK_SELECT.trigger),
    action: pick(r.action, LINK_ACTIONS, DEFAULT_LINK_SELECT.action),
    copyFormat: pick(r.copyFormat, LINK_COPY_FORMATS, DEFAULT_LINK_SELECT.copyFormat),
    smart: r.smart !== false,
  };
}

// http(s) only, no links to a spot on the page itself, first occurrence of
// each URL wins (order is the order on the page).
export function cleanLinks(items, pageUrl) {
  let pageNoHash = "";
  try {
    const p = new URL(pageUrl);
    p.hash = "";
    pageNoHash = p.href;
  } catch {
    // no page URL: nothing counts as same-page
  }
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    let u;
    try {
      u = new URL(String((item && item.url) || ""));
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (u.hash) {
      const bare = new URL(u.href);
      bare.hash = "";
      if (bare.href === pageNoHash) continue;
    }
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    const text = String((item && item.text) || "").replace(/\s+/g, " ").trim().slice(0, 300);
    out.push({ url: u.href, text });
  }
  return out;
}

export function formatLinks(links, format) {
  const md = (t) => t.replace(/([\\[\]])/g, "\\$1");
  return links
    .map((l) => {
      if (format === "titles") return `${l.text || l.url}\t${l.url}`;
      if (format === "markdown") return `- [${md(l.text || l.url)}](${l.url.replace(/\)/g, "%29")})`;
      return l.url;
    })
    .join("\n");
}
