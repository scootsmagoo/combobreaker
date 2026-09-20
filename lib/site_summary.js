// "What have I changed for this site?" for the popup's Site tab: one short
// label per per-site setting that differs from the default. Pure.

const REFERRER_LABEL = {
  "strict-origin-when-cross-origin": "referrer: origin only",
  "same-origin": "referrer hidden from other sites",
  "no-referrer": "referrer never sent",
};

// settings: SiteSettings (lib/storage.js); jsEnabled: Chrome's content setting.
// Returns [{ label, kind }], kind = "block" | "style" | "privacy" | "net".
export function summarizeSite(settings, jsEnabled) {
  const s = settings || {};
  const out = [];
  const add = (label, kind) => out.push({ label, kind });
  if (jsEnabled === false) add("JavaScript blocked", "block");
  if (s.adblockPaused) add("ad blocking paused", "block");
  if (s.darkMode === "on") add("dark mode forced on", "style");
  if (s.darkMode === "off") add("dark mode off", "style");
  if (s.css && s.css.trim()) add(s.cssEnabled ? "custom CSS" : "custom CSS (off)", "style");
  if (s.js && s.js.trim()) add(s.jsEnabled ? "custom JS" : "custom JS (off)", "style");
  if (s.autoClear) add("forgotten on close", "privacy");
  if (s.blockThirdPartyCookies) add("third-party cookies blocked", "privacy");
  if (REFERRER_LABEL[s.referrerPolicy]) add(REFERRER_LABEL[s.referrerPolicy], "privacy");
  const headers = (s.requestHeaders || []).length + (s.responseHeaders || []).length;
  if (headers) add(`${headers} header rule${headers === 1 ? "" : "s"}`, "net");
  if (s.mediaOverlay === false) add("download badges hidden", "style");
  if (s.mediaOverlay === true) add("download badges forced on", "style");
  return out;
}
