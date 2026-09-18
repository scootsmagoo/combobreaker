import { siteKeyFromUrl, prettySite } from "../lib/site.js";
import { getGlobal, setGlobal } from "../lib/storage.js";
import { initUtilities } from "./utilities.js";
import { initSnippets } from "./snippets.js";

const $ = (id) => document.getElementById(id);

const STATE = {
  tab: null,
  siteKey: null,
  settings: null,
  global: null,
  jsEnabled: true,
  activeTab: "site",
};

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  STATE.tab = tab;
  STATE.siteKey = siteKeyFromUrl(tab?.url);

  $("site-name").textContent = prettySite(STATE.siteKey);

  STATE.global = await getGlobal();
  renderAdblockLevel(STATE.global.adblockLevel);
  $("g-json").checked = !!STATE.global.jsonFormatterEnabled;
  $("t-darkmode-global").checked = !!STATE.global.darkMode.enabled;
  renderDarkOverride(null);
  bindDarkSection();

  if (STATE.siteKey) {
    try {
      const state = await sendMessage({ type: "get-site-state", siteKey: STATE.siteKey });
      STATE.settings = state.settings;
      STATE.jsEnabled = state.jsEnabled;
      renderSiteToggles();
    } catch (e) {
      disableSiteToggles(String(e.message || e));
    }
  } else {
    disableSiteToggles("Per-site features need an http(s) page.");
  }

  bindTabs();
  bindSitePane();
  bindCookiesPane();
  bindHeadersPane();
  bindRedirectsPane();
  bindMediaPane();
  bindBrowsePane();
  bindToolsPane();
  bindDialogs();
  initUtilities({ tab: STATE.tab, status });
  initSnippets({ tab: STATE.tab, status, sendMessage });
  if (STATE.tab && STATE.tab.id != null) {
    try {
      const bp = chrome.runtime.connect({ name: "browsing-popup" });
      bp.postMessage({ type: "active-tab", tabId: STATE.tab.id, noCache: true });
    } catch (_) {
      // ignore
    }
  }
}

//  Tab routing 

function bindTabs() {
  document.querySelectorAll(".tab[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  STATE.activeTab = name;
  document.querySelectorAll(".tab[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".pane").forEach((p) => {
    p.classList.toggle("active", p.id === `pane-${name}`);
  });
  if (name === "cookies") loadCookies();
  if (name === "redirects") loadRedirects();
  if (name === "headers") loadHeaders();
  if (name === "media") loadMedia();
  if (name === "browse") loadBrowse();
}

//  Site pane 

function renderSiteToggles() {
  const s = STATE.settings;
  $("t-js").checked = !!STATE.jsEnabled;
  $("t-css").checked = !!s.cssEnabled;
  $("t-userjs").checked = !!s.jsEnabled;
  $("t-adblock-pause").checked = !!s.adblockPaused;
  $("t-auto-clear").checked = !!s.autoClear;
  $("t-3p-cookies").checked = !!s.blockThirdPartyCookies;
  $("t-referrer").value = s.referrerPolicy || "";
  // A switch with nothing behind it does nothing; say so.
  $("t-css-state").textContent = s.css && s.css.trim() ? "" : "nothing written yet";
  $("t-userjs-state").textContent = s.js && s.js.trim() ? "" : "nothing written yet";
  renderDarkOverride(s.darkMode);
}

function renderDarkOverride(value) {
  const norm = value === "on" || value === "off" ? value : "";
  document
    .querySelectorAll(".site-override .seg-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.val === norm));
}

function disableSiteToggles(reason) {
  for (const id of ["t-js", "t-css", "t-userjs", "t-adblock-pause", "t-auto-clear", "t-3p-cookies", "t-referrer"]) $(id).disabled = true;
  document
    .querySelectorAll(".site-override .seg-btn")
    .forEach((b) => (b.disabled = true));
  status(reason, "err");
}

// "?" tips live inside <label> rows; a click must not flip the switch.
function bindTips() {
  document.querySelectorAll(".tip").forEach((t) => {
    t.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      t.focus();
    });
  });
}

function renderAdblockLevel(level) {
  document
    .querySelectorAll(".adblock-level .seg-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.level === level));
  // Pausing means nothing while blocking is off everywhere.
  $("t-adblock-pause").closest(".row").classList.toggle("dimmed", level === "off");
}

function bindAdblock() {
  document.querySelectorAll(".adblock-level .seg-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const level = btn.dataset.level;
      await setGlobal({ adblockLevel: level });
      await sendMessage({ type: "apply-adblock" });
      STATE.global.adblockLevel = level;
      renderAdblockLevel(level);
      const label = { off: "off", basic: "Basic (about 40 big ad and tracking companies)", strong: "Strong (about 3,500 ad and tracking servers)" }[level];
      status(`Ad blocking: ${label}. Reload pages to apply.`, "ok");
    });
  });
  $("t-adblock-pause").addEventListener("change", async (e) => {
    if (!STATE.siteKey) return;
    const paused = e.target.checked;
    await sendMessage({ type: "set-site", siteKey: STATE.siteKey, patch: { adblockPaused: paused } });
    await sendMessage({ type: "apply-adblock" });
    if (STATE.settings) STATE.settings.adblockPaused = paused;
    status(paused ? `Blocking paused on ${STATE.siteKey}. Reload the page.` : `Blocking resumed on ${STATE.siteKey}. Reload the page.`, "ok");
  });
}

async function setSitePrivacy(patch) {
  await sendMessage({ type: "set-site", siteKey: STATE.siteKey, patch });
  if (STATE.settings) Object.assign(STATE.settings, patch);
}

function bindPrivacy() {
  $("t-auto-clear").addEventListener("change", async (e) => {
    if (!STATE.siteKey) return;
    const on = e.target.checked;
    await setSitePrivacy({ autoClear: on });
    await sendMessage({ type: "apply-auto-clear" });
    status(on ? `${STATE.siteKey} will be forgotten when its last tab closes.` : `${STATE.siteKey} keeps its data again.`, "ok");
  });
  $("t-3p-cookies").addEventListener("change", async (e) => {
    if (!STATE.siteKey) return;
    const on = e.target.checked;
    await setSitePrivacy({ blockThirdPartyCookies: on });
    await sendMessage({ type: "apply-site-headers", siteKey: STATE.siteKey });
    status(`Third-party cookies ${on ? "blocked" : "allowed"} on ${STATE.siteKey}. Reload the page.`, "ok");
  });
  $("t-referrer").addEventListener("change", async (e) => {
    if (!STATE.siteKey) return;
    await setSitePrivacy({ referrerPolicy: e.target.value });
    await sendMessage({ type: "apply-site-headers", siteKey: STATE.siteKey });
    status(e.target.value ? "Referrer override saved. Reload the page." : "Referrer override removed. Reload the page.", "ok");
  });
}

function bindSitePane() {
  bindTips();
  bindAdblock();
  bindPrivacy();
  $("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

  $("t-js").addEventListener("change", async (e) => {
    if (!STATE.siteKey) return;
    const enabled = e.target.checked;
    await sendMessage({ type: "set-js-enabled", siteKey: STATE.siteKey, enabled });
    status(`JS ${enabled ? "enabled" : "blocked"}. Reloading…`, "ok");
    setTimeout(() => chrome.tabs.reload(STATE.tab.id), 250);
  });

  $("t-css").addEventListener("change", async (e) => {
    if (!STATE.siteKey) return;
    const enabled = e.target.checked;
    await sendMessage({ type: "set-site", siteKey: STATE.siteKey, patch: { cssEnabled: enabled } });
    const empty = !(STATE.settings && STATE.settings.css && STATE.settings.css.trim());
    status(enabled && empty ? "Custom CSS is on, but nothing is written yet. Click Edit CSS." : `Custom CSS ${enabled ? "on" : "off"}.`, "ok");
  });

  $("t-userjs").addEventListener("change", async (e) => {
    if (!STATE.siteKey) return;
    const enabled = e.target.checked;
    await sendMessage({ type: "set-site", siteKey: STATE.siteKey, patch: { jsEnabled: enabled } });
    const empty = !(STATE.settings && STATE.settings.js && STATE.settings.js.trim());
    status(enabled && empty ? "Custom JS is on, but nothing is written yet. Click Edit JS." : `Custom JS ${enabled ? "on" : "off"}. Reload the page to apply.`, "ok");
  });

  document.querySelectorAll('[data-tool="edit-css"], [data-tool="edit-js"]').forEach((b) =>
    b.addEventListener("click", () => onTool(b.dataset.tool))
  );
}

//  Dark mode controls 

function bindDarkSection() {
  $("t-darkmode-global").addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    await sendMessage({
      type: "set-global",
      patch: { darkMode: { enabled } },
    });
    STATE.global.darkMode.enabled = enabled;
    status(`Dark mode ${enabled ? "on" : "off"} (all sites)`, "ok");
  });

  document.querySelectorAll(".site-override .seg-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!STATE.siteKey || btn.disabled) return;
      const val = btn.dataset.val;
      const override = val === "on" ? "on" : val === "off" ? "off" : null;
      await sendMessage({
        type: "set-site",
        siteKey: STATE.siteKey,
        patch: { darkMode: override },
      });
      if (STATE.settings) STATE.settings.darkMode = override;
      renderDarkOverride(override);
      const label =
        override === "on"
          ? `forced on for ${STATE.siteKey}`
          : override === "off"
            ? `disabled for ${STATE.siteKey}`
            : `following global for ${STATE.siteKey}`;
      status(`Dark mode ${label}`, "ok");
    });
  });

  $("open-dark-tune").addEventListener("click", openDarkTune);
  bindDarkTuneDialog();
}

const TUNE_FIELDS = [
  ["brightness", "tune-brightness", "tune-brightness-out", 100],
  ["contrast", "tune-contrast", "tune-contrast-out", 100],
  ["sepia", "tune-sepia", "tune-sepia-out", 0],
  ["grayscale", "tune-grayscale", "tune-grayscale-out", 0],
];

function openDarkTune() {
  const t = STATE.global.darkMode.theme;
  $("tune-mode").value = String(t.mode ?? 1);
  for (const [field, inputId, outId] of TUNE_FIELDS) {
    $(inputId).value = String(t[field]);
    $(outId).textContent = String(t[field]);
  }
  $("dark-tune-dialog").showModal();
}

function bindDarkTuneDialog() {
  const push = debounce(async (patch) => {
    STATE.global.darkMode.theme = { ...STATE.global.darkMode.theme, ...patch };
    await sendMessage({
      type: "set-global",
      patch: { darkMode: { theme: patch } },
    });
  }, 120);

  $("tune-mode").addEventListener("change", (e) => {
    push({ mode: Number(e.target.value) });
  });

  for (const [field, inputId, outId] of TUNE_FIELDS) {
    $(inputId).addEventListener("input", (e) => {
      const v = Number(e.target.value);
      $(outId).textContent = String(v);
      push({ [field]: v });
    });
  }

  $("tune-reset").addEventListener("click", async (e) => {
    e.preventDefault();
    const defaults = { brightness: 100, contrast: 100, sepia: 0, grayscale: 0, mode: 1 };
    $("tune-mode").value = String(defaults.mode);
    for (const [field, inputId, outId] of TUNE_FIELDS) {
      $(inputId).value = String(defaults[field]);
      $(outId).textContent = String(defaults[field]);
    }
    STATE.global.darkMode.theme = { ...defaults };
    await sendMessage({
      type: "set-global",
      patch: { darkMode: { theme: defaults } },
    });
    status("Dark mode tuning reset", "ok");
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

//  Cookies pane 
// Uses chrome.cookies directly (popup has the permission).

let COOKIES_CACHE = [];

function bindCookiesPane() {
  $("cookies-refresh").addEventListener("click", () => loadCookies(true));
  $("cookies-nuke").addEventListener("click", nukeCookies);
  $("site-data-nuke").addEventListener("click", nukeSiteData);
}

async function loadCookies(force = false) {
  const list = $("cookies-list");
  if (!STATE.siteKey) {
    list.innerHTML = `<div class="empty muted">Cookies are unavailable on this page.</div>`;
    $("cookies-count").textContent = "—";
    return;
  }
  if (!force && list.dataset.loaded === STATE.siteKey) return;
  list.innerHTML = `<div class="empty muted">Loading…</div>`;
  try {
    const cookies = await chrome.cookies.getAll({ domain: STATE.siteKey });
    cookies.sort((a, b) => a.name.localeCompare(b.name));
    COOKIES_CACHE = cookies;
    renderCookies(cookies);
    list.dataset.loaded = STATE.siteKey;
  } catch (e) {
    list.innerHTML = `<div class="empty muted">Error: ${escapeHtml(String(e.message || e))}</div>`;
  }
}

function renderCookies(cookies) {
  const list = $("cookies-list");
  $("cookies-count").textContent = `${cookies.length} cookie${cookies.length === 1 ? "" : "s"}`;
  if (cookies.length === 0) {
    list.innerHTML = `<div class="empty muted">No cookies for this site.</div>`;
    return;
  }
  list.innerHTML = "";
  for (const c of cookies) {
    list.appendChild(renderCookieRow(c));
  }
}

function renderCookieRow(c) {
  const row = document.createElement("div");
  row.className = "cookie";

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = c.name;
  row.appendChild(name);

  const actions = document.createElement("div");
  actions.className = "actions";
  const editBtn = document.createElement("button");
  editBtn.className = "cookie-icon-btn edit";
  editBtn.title = "Edit";
  editBtn.textContent = "✎";
  editBtn.addEventListener("click", () => openCookieDialog(c));
  const delBtn = document.createElement("button");
  delBtn.className = "cookie-icon-btn del";
  delBtn.title = "Delete";
  delBtn.textContent = "✕";
  delBtn.addEventListener("click", () => deleteCookie(c));
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  row.appendChild(actions);

  const value = document.createElement("div");
  value.className = "value";
  value.textContent = c.value || "(empty)";
  value.title = "Click to expand / collapse";
  value.addEventListener("click", () => {
    value.style.whiteSpace = value.style.whiteSpace === "pre-wrap" ? "nowrap" : "pre-wrap";
    value.style.wordBreak = value.style.whiteSpace === "pre-wrap" ? "break-all" : "";
  });
  row.appendChild(value);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.appendChild(badge(c.domain, "domain"));
  meta.appendChild(badge(c.path, "path"));
  meta.appendChild(badge(formatExpires(c), c.session ? "session" : ""));
  if (c.secure) meta.appendChild(badge("secure", "sec"));
  if (c.httpOnly) meta.appendChild(badge("httpOnly", "http"));
  if (c.sameSite && c.sameSite !== "unspecified") meta.appendChild(badge(`SameSite=${c.sameSite}`));
  row.appendChild(meta);

  return row;
}

function badge(text, cls = "") {
  const b = document.createElement("span");
  b.className = "badge" + (cls ? " " + cls : "");
  b.textContent = text;
  return b;
}

function formatExpires(c) {
  if (c.session) return "session";
  if (!c.expirationDate) return "session";
  const d = new Date(c.expirationDate * 1000);
  if (isNaN(d.getTime())) return "session";
  const now = Date.now();
  const ms = d.getTime() - now;
  const days = Math.round(ms / (1000 * 60 * 60 * 24));
  if (days < 0) return `expired ${-days}d ago`;
  if (days === 0) return "expires today";
  if (days < 365) return `${days}d`;
  return `${Math.round(days / 365)}y`;
}

async function deleteCookie(c) {
  if (!confirm(`Delete cookie "${c.name}" from ${c.domain}?`)) return;
  try {
    await chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId });
    status(`Deleted "${c.name}"`, "ok");
    loadCookies(true);
  } catch (e) {
    status(`Delete failed: ${e.message}`, "err");
  }
}

async function nukeCookies() {
  const cookies = COOKIES_CACHE;
  if (!cookies.length) return;
  if (!confirm(`Delete ALL ${cookies.length} cookies for ${STATE.siteKey}?\n\nThis will log you out of any session on this site.`)) return;
  let ok = 0, fail = 0;
  for (const c of cookies) {
    try {
      await chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId });
      ok++;
    } catch {
      fail++;
    }
  }
  status(`Nuked ${ok} cookie${ok === 1 ? "" : "s"}${fail ? `, ${fail} failed` : ""}`, fail ? "err" : "ok");
  loadCookies(true);
}

// Everything DevTools → Application → "Clear site data" does, in one click.
async function nukeSiteData() {
  if (!STATE.siteKey || !STATE.tab) return;
  if (!confirm(`Clear ALL stored data for ${STATE.siteKey}?

Cookies, localStorage, IndexedDB, Cache Storage and service workers. You will be logged out.`)) return;
  try {
    const res = await sendMessage({ type: "nuke-site-data", siteKey: STATE.siteKey, tabUrl: STATE.tab.url });
    status(`Cleared site data for ${res.origins.length} origin(s). Reload the page.`, "ok");
  } catch (e) {
    status(String(e.message || e), "err");
  }
  loadCookies(true);
}

function cookieUrl(c) {
  const protocol = c.secure ? "https:" : "http:";
  const host = c.domain.replace(/^\./, "");
  return `${protocol}//${host}${c.path || "/"}`;
}

let DIALOG_COOKIE = null;
function openCookieDialog(c) {
  DIALOG_COOKIE = c;
  $("cookie-dialog-title").textContent = `Edit "${c.name}"`;
  $("cookie-name").value = c.name;
  $("cookie-value").value = c.value || "";
  $("cookie-meta-domain").textContent = `domain: ${c.domain}`;
  $("cookie-meta-path").textContent = `path: ${c.path}`;
  $("cookie-meta-expires").textContent = `expires: ${formatExpires(c)}`;
  const flags = [];
  if (c.secure) flags.push("secure");
  if (c.httpOnly) flags.push("httpOnly");
  if (c.sameSite && c.sameSite !== "unspecified") flags.push(`SameSite=${c.sameSite}`);
  $("cookie-meta-flags").textContent = flags.length ? flags.join(", ") : "no flags";
  $("cookie-dialog").showModal();
}

async function saveCookie(e) {
  e.preventDefault();
  const c = DIALOG_COOKIE;
  if (!c) return;
  const newValue = $("cookie-value").value;
  $("cookie-dialog").close();
  try {
    const setArgs = {
      url: cookieUrl(c),
      name: c.name,
      value: newValue,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite || "unspecified",
      storeId: c.storeId,
    };
    if (!c.session && c.expirationDate) setArgs.expirationDate = c.expirationDate;
    await chrome.cookies.set(setArgs);
    status(`Saved "${c.name}"`, "ok");
    loadCookies(true);
  } catch (err) {
    status(`Save failed: ${err.message}`, "err");
  }
}

//  Headers pane 

function bindHeadersPane() {
  $("headers-refresh").addEventListener("click", () => loadHeaders(true));
  $("headers-edit").addEventListener("click", async () => {
    if (!STATE.siteKey) {
      status("Per-site overrides need an http(s) page.", "err");
      return;
    }
    const url = chrome.runtime.getURL(
      `options/options.html#headers/${encodeURIComponent(STATE.siteKey)}`
    );
    await chrome.tabs.create({ url });
    window.close();
  });
}

async function loadHeaders(_force = false) {
  if (!STATE.tab) return;
  const list = $("headers-list");
  list.innerHTML = `<div class="empty muted">Loading…</div>`;
  try {
    const [entry, settings] = await Promise.all([
      sendMessage({ type: "get-response-headers", tabId: STATE.tab.id }),
      STATE.siteKey ? sendMessage({ type: "get-site-state", siteKey: STATE.siteKey }) : Promise.resolve(null),
    ]);
    renderHeaders(entry);
    renderOverrideSummary(settings ? settings.settings : null);
  } catch (e) {
    list.innerHTML = `<div class="empty muted">Error: ${escapeHtml(String(e.message || e))}</div>`;
  }
}

function renderHeaders(entry) {
  const list = $("headers-list");
  const statusEl = $("headers-status");
  if (!entry) {
    statusEl.textContent = "No response captured";
    list.innerHTML = `<div class="empty muted">Reload the page to capture response headers.</div>`;
    return;
  }
  const sc = String(entry.status || "");
  const cls = sc.startsWith("3")
    ? "s3xx"
    : sc.startsWith("2")
      ? "s2xx"
      : sc.startsWith("4")
        ? "s4xx"
        : sc.startsWith("5")
          ? "s5xx"
          : "";
  statusEl.innerHTML = `<span class="status-pill ${cls}">HTTP ${escapeHtml(sc)}</span> <span class="muted">${entry.headers.length} headers</span>`;

  list.innerHTML = "";
  if (!entry.headers.length) {
    list.innerHTML = `<div class="empty muted">No response headers recorded.</div>`;
    return;
  }
  for (const h of entry.headers) {
    list.appendChild(renderHeaderRow(h));
  }
}

function renderHeaderRow(h) {
  const row = document.createElement("div");
  row.className = "header-row";
  row.title = "Click to copy";
  row.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`${h.name}: ${h.value}`);
      status(`Copied "${h.name}"`, "ok");
    } catch {}
  });
  const name = document.createElement("span");
  name.className = "h-name";
  name.textContent = h.name;
  const value = document.createElement("span");
  value.className = "h-value";
  value.textContent = h.value;
  row.appendChild(name);
  row.appendChild(value);
  return row;
}

function renderOverrideSummary(settings) {
  const el = $("headers-overrides");
  if (!settings) {
    el.textContent = "";
    return;
  }
  const req = (settings.requestHeaders || []).length;
  const res = (settings.responseHeaders || []).length;
  if (!req && !res) {
    el.textContent = "No header overrides for this site.";
    return;
  }
  const parts = [];
  if (req) parts.push(`${req} request override${req === 1 ? "" : "s"}`);
  if (res) parts.push(`${res} response override${res === 1 ? "" : "s"}`);
  el.textContent = parts.join(" · ") + " active.";
}

//  Redirects pane 

function bindRedirectsPane() {
  $("redirects-refresh").addEventListener("click", () => loadRedirects(true));
  $("redirects-clear").addEventListener("click", clearRedirects);
  $("redirects-copy").addEventListener("click", copyRedirects);
}

let REDIRECTS_CACHE = [];

async function loadRedirects(_force = false) {
  if (!STATE.tab) return;
  const list = $("redirects-list");
  list.innerHTML = `<div class="empty muted">Loading…</div>`;
  try {
    const chain = await sendMessage({ type: "get-redirect-chain", tabId: STATE.tab.id });
    REDIRECTS_CACHE = chain;
    renderRedirects(chain);
  } catch (e) {
    list.innerHTML = `<div class="empty muted">Error: ${escapeHtml(String(e.message || e))}</div>`;
  }
}

function renderRedirects(chain) {
  const list = $("redirects-list");
  const redirectCount = chain.filter((s) => s.type === "redirect").length;
  $("redirects-count").textContent = redirectCount === 0
    ? "No redirects on this tab"
    : `${redirectCount} redirect${redirectCount === 1 ? "" : "s"}`;

  if (chain.length === 0) {
    list.innerHTML = `<div class="empty muted">No requests recorded yet. Reload the page to capture the chain.</div>`;
    return;
  }
  list.innerHTML = "";
  let stepNum = 0;
  for (const entry of chain) {
    if (entry.type === "start") {
      list.appendChild(renderStep("start", "→", entry.url, null));
    } else if (entry.type === "redirect") {
      stepNum++;
      list.appendChild(renderStep("redirect", String(stepNum), entry.to, entry.status));
    } else if (entry.type === "end") {
      list.appendChild(renderStep("end", "✓", entry.url, entry.status));
    }
  }
}

function renderStep(kind, marker, url, status) {
  const wrap = document.createElement("div");
  wrap.className = `redirect-step ${kind}`;

  const m = document.createElement("div");
  m.className = "marker";
  m.textContent = marker;
  wrap.appendChild(m);

  const right = document.createElement("div");
  const urlEl = document.createElement("div");
  urlEl.className = "url";
  try {
    const u = new URL(url);
    urlEl.innerHTML =
      `<span class="scheme">${u.protocol}//</span>` +
      `<span class="host">${escapeHtml(u.host)}</span>` +
      escapeHtml(u.pathname + u.search + u.hash);
  } catch {
    urlEl.textContent = url;
  }
  urlEl.title = "Click to copy URL";
  urlEl.style.cursor = "pointer";
  urlEl.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      status_brief(urlEl, "copied");
    } catch {}
  });
  right.appendChild(urlEl);

  if (status != null || kind !== "start") {
    const meta = document.createElement("div");
    meta.className = "meta";
    if (status != null) {
      const sc = String(status);
      const cls = sc.startsWith("3") ? "s3xx" : sc.startsWith("2") ? "s2xx" : sc.startsWith("4") ? "s4xx" : sc.startsWith("5") ? "s5xx" : "";
      const s = document.createElement("span");
      s.className = `status ${cls}`;
      s.textContent = `HTTP ${sc}`;
      meta.appendChild(s);
    }
    right.appendChild(meta);
  }

  wrap.appendChild(right);
  return wrap;
}

function status_brief(el, text) {
  const original = el.style.color;
  const originalText = el.textContent;
  el.style.color = "var(--ok)";
  el.textContent = text;
  setTimeout(() => {
    el.style.color = original;
    el.innerHTML = "";
    try {
      const u = new URL(originalText);
      el.innerHTML =
        `<span class="scheme">${u.protocol}//</span>` +
        `<span class="host">${escapeHtml(u.host)}</span>` +
        escapeHtml(u.pathname + u.search + u.hash);
    } catch {
      el.textContent = originalText;
    }
  }, 800);
}

async function clearRedirects() {
  if (!STATE.tab) return;
  try {
    await sendMessage({ type: "clear-redirect-chain", tabId: STATE.tab.id });
    status("Redirect chain cleared", "ok");
    loadRedirects(true);
  } catch (e) {
    status(`Clear failed: ${e.message}`, "err");
  }
}

async function copyRedirects() {
  const lines = [];
  for (const e of REDIRECTS_CACHE) {
    if (e.type === "start") lines.push(`→ ${e.url}`);
    else if (e.type === "redirect") lines.push(`  ${e.status}  →  ${e.to}`);
    else if (e.type === "end") lines.push(`✓ ${e.status}  ${e.url}`);
  }
  try {
    await navigator.clipboard.writeText(lines.join("\n") || "(empty)");
    status("Chain copied", "ok");
  } catch (e) {
    status(`Copy failed: ${e.message}`, "err");
  }
}

//  Media pane

const QUALITY_PRESETS = [
  ["best", "Best"],
  ["1080", "1080p"],
  ["720", "720p"],
  ["480", "480p"],
  ["audio", "Audio (MP3)"],
];

const MEDIA = {
  bridge: null, // result of ytdlp-status
  items: [], // videos on the page (from content/media_overlay.js)
  jobs: [], // yt-dlp jobs (from the bridge)
  overlaySite: null, // true | false | null
  overlayGlobal: true,
};

function bindMediaPane() {
  $("media-refresh").addEventListener("click", async () => {
    if (!STATE.tab) return;
    try {
      await chrome.tabs.sendMessage(STATE.tab.id, { type: "cb-media-rescan" });
    } catch {
      // Content script may not be present (chrome:// etc.) — fine.
    }
    setTimeout(() => loadMedia(true), 300);
  });
  $("media-clear").addEventListener("click", async () => {
    if (!STATE.tab) return;
    try {
      await sendMessage({ type: "media-clear", tabId: STATE.tab.id });
      await sendMessage({ type: "ytdlp-clear-jobs" });
      status("Media list cleared", "ok");
      loadMedia(true);
    } catch (e) {
      status(`Clear failed: ${e.message}`, "err");
    }
  });
  $("media-ytdlp").addEventListener("click", copyYtDlp);
  $("bridge-setup").addEventListener("click", () => {
    sendMessage({ type: "open-helper-setup" }).catch(() => {});
    window.close();
  });
  $("bridge-recheck").addEventListener("click", () => checkBridge(true));
  $("media-jobs-clear").addEventListener("click", async () => {
    try {
      await sendMessage({ type: "ytdlp-clear-jobs" });
      loadJobs();
    } catch (e) {
      status(`Failed: ${e.message}`, "err");
    }
  });

  $("t-overlay-global").addEventListener("change", async (e) => {
    MEDIA.overlayGlobal = e.target.checked;
    try {
      await sendMessage({ type: "set-global", patch: { mediaOverlayEnabled: MEDIA.overlayGlobal } });
      status(`Badges ${MEDIA.overlayGlobal ? "on" : "off"} by default`, "ok");
    } catch (err) {
      status(`Failed: ${err.message}`, "err");
    }
    renderOverlayToggles();
  });
  $("t-overlay-site").addEventListener("change", async (e) => {
    if (!STATE.siteKey) return;
    const want = e.target.checked;
    // Store an explicit value only when it differs from the global default.
    const value = want === MEDIA.overlayGlobal ? null : want;
    MEDIA.overlaySite = value;
    try {
      await sendMessage({ type: "set-site", siteKey: STATE.siteKey, patch: { mediaOverlay: value } });
      status(`Badges ${want ? "on" : "off"} for ${STATE.siteKey}`, "ok");
    } catch (err) {
      status(`Failed: ${err.message}`, "err");
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "cb-ytdlp-job" && msg.job) {
      const i = MEDIA.jobs.findIndex((j) => j.id === msg.job.id);
      if (i >= 0) MEDIA.jobs[i] = { ...MEDIA.jobs[i], ...msg.job };
      else MEDIA.jobs.unshift(msg.job);
      if (STATE.activeTab === "media") {
        renderJobs();
        renderVideoProgress();
      }
    }
  });
}

async function loadMedia(_force = false) {
  if (!STATE.tab) return;
  MEDIA.overlayGlobal = STATE.global ? STATE.global.mediaOverlayEnabled !== false : true;
  MEDIA.overlaySite = STATE.settings ? STATE.settings.mediaOverlay ?? null : null;
  renderOverlayToggles();
  checkBridge(false);
  loadJobs();
  loadVideos();
  loadRaw();
}

function renderOverlayToggles() {
  const g = MEDIA.overlayGlobal;
  const s = MEDIA.overlaySite;
  $("t-overlay-global").checked = !!g;
  $("t-overlay-site").checked = s === true ? true : s === false ? false : !!g;
  $("t-overlay-site").disabled = !STATE.siteKey;
}

//  yt-dlp bridge status

async function checkBridge(force) {
  const dot = $("bridge-dot");
  const text = $("bridge-text");
  const setup = $("bridge-setup");
  if (force) {
    dot.className = "bridge-dot";
    text.textContent = "Checking the Helper…";
  }
  try {
    MEDIA.bridge = await sendMessage({ type: "ytdlp-status", force: !!force });
  } catch (e) {
    MEDIA.bridge = { available: false, error: String(e.message || e) };
  }
  const b = MEDIA.bridge || {};
  if (b.available) {
    dot.className = `bridge-dot ${b.ffmpeg ? "ok" : "warn"}`;
    text.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = "Helper connected";
    text.appendChild(strong);
    text.appendChild(document.createTextNode(` · yt-dlp ${b.ytdlp && b.ytdlp.version ? b.ytdlp.version : ""}`.trimEnd() + (b.ffmpeg ? "" : " · ffmpeg missing")));
    text.title = [b.ytdlp && (b.ytdlp.display || b.ytdlp.path), b.ffmpeg && b.ffmpeg.path, b.outputDir && `→ ${b.outputDir}`]
      .filter(Boolean)
      .join("\n");
    setup.hidden = true;
  } else {
    const notInstalled = /not installed/i.test(b.error || "");
    dot.className = "bridge-dot err";
    text.textContent = notInstalled ? "Helper not set up · needed for YouTube" : `Helper: ${b.error || "not installed"}`;
    text.title = b.error || "";
    setup.textContent = notInstalled ? "Set up" : "Repair";
    setup.hidden = false;
  }
  if (MEDIA.items.length) renderVideos();
}

//  Videos on the page

async function loadVideos() {
  const wrap = $("media-videos");
  const hint = $("media-videos-hint");
  wrap.innerHTML = `<div class="empty muted">Scanning…</div>`;
  hint.textContent = "";
  let items = null;
  try {
    items = await sendMessage({ type: "overlay-list-all", tabId: STATE.tab.id });
  } catch {
    items = null;
  }
  MEDIA.items = items || [];
  if (!items) {
    wrap.innerHTML = `<div class="empty muted">No access to this page (chrome://, PDF, or the tab needs a reload after installing ComboBreaker).</div>`;
    return;
  }
  renderVideos();
}

function renderVideos() {
  const wrap = $("media-videos");
  const hint = $("media-videos-hint");
  const items = MEDIA.items;
  $("media-count").textContent = items.length ? `${items.length} video${items.length === 1 ? "" : "s"}` : "—";
  if (!items.length) {
    wrap.innerHTML = `<div class="empty muted">No videos found. Hover a player or thumbnail on the page to get a download badge; play the video if it loads lazily.</div>`;
    return;
  }
  hint.textContent = items.length > 1 ? "click a title to find it on the page" : "";
  wrap.innerHTML = "";
  for (const it of items) wrap.appendChild(renderVideoRow(it));
}

function primarySourceOf(it) {
  const order = ["mp4", "webm", "mov", "mkv", "ogg", "hls", "dash", "mp3", "m4a", "video", "ytdlp"];
  let best = null;
  let br = 99;
  for (const s of it.sources || []) {
    const r = order.indexOf(s.kind);
    const rank = r < 0 ? 50 : r;
    if (rank < br) {
      best = s;
      br = rank;
    }
  }
  return best;
}

function renderVideoRow(it) {
  const row = document.createElement("div");
  row.className = "media-video";
  row.dataset.itemId = it.id;

  let thumb;
  if (it.thumb && /^https?:/.test(it.thumb)) {
    thumb = document.createElement("img");
    thumb.className = "thumb";
    thumb.src = it.thumb;
    thumb.alt = "";
    thumb.referrerPolicy = "no-referrer";
    thumb.addEventListener("error", () => {
      const ph = placeholderThumb();
      thumb.replaceWith(ph);
    });
  } else {
    thumb = placeholderThumb();
  }
  thumb.title = "Find on page";
  thumb.addEventListener("click", () => locateItem(it.id, it.frameId));
  row.appendChild(thumb);

  const info = document.createElement("div");
  info.className = "info";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = it.title || it.page || it.id;
  title.title = `${it.title || ""}\n${it.page || ""}\n(click to find on page)`.trim();
  title.addEventListener("click", () => locateItem(it.id, it.frameId));
  info.appendChild(title);
  const meta = document.createElement("div");
  meta.className = "meta";
  if (it.site && it.site !== "generic") meta.appendChild(badge(it.site === "twitter" ? "X" : it.site));
  if (it.frameId) meta.appendChild(badge("embed"));
  if (it.width && it.height) meta.appendChild(badge(`${it.width}×${it.height}`));
  if (it.duration) meta.appendChild(badge(formatDurationShort(it.duration)));
  if (it.gif) meta.appendChild(badge("GIF"));
  const kinds = [...new Set((it.sources || []).map((s) => s.kind))].filter((k) => k !== "ytdlp");
  for (const k of kinds.slice(0, 3)) meta.appendChild(badge(k.toUpperCase()));
  if (!kinds.length) meta.appendChild(badge("via Helper"));
  info.appendChild(meta);
  row.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "actions";
  const primary = primarySourceOf(it);
  const bridgeOk = !!(MEDIA.bridge && MEDIA.bridge.available);
  const directSources = (it.sources || []).filter((s) => !["ytdlp", "hls", "dash"].includes(s.kind));
  const ytd = (it.sources || []).find((s) => s.kind === "ytdlp");

  if (primary && directSources.length) {
    let picked = directSources[0];
    if (directSources.length > 1) {
      const sel = document.createElement("select");
      sel.className = "q";
      sel.title = "Pick a variant";
      directSources.forEach((s, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = [s.res || s.label, s.bitrate ? `${(s.bitrate / 1e6).toFixed(1)}M` : ""].filter(Boolean).join(" ");
        sel.appendChild(o);
      });
      sel.addEventListener("change", () => (picked = directSources[Number(sel.value)]));
      actions.appendChild(sel);
    }
    const dl = document.createElement("button");
    dl.className = "media-btn primary";
    dl.textContent = "Download";
    dl.addEventListener("click", () => overlayDownloadFromPopup(it, picked, "best"));
    actions.appendChild(dl);
  } else if (bridgeOk && (ytd || primary)) {
    const sel = document.createElement("select");
    sel.className = "q";
    for (const [q, label] of QUALITY_PRESETS) {
      if (q === "audio" && !(MEDIA.bridge && MEDIA.bridge.ffmpeg)) continue;
      const o = document.createElement("option");
      o.value = q;
      o.textContent = label;
      sel.appendChild(o);
    }
    const def = STATE.global && STATE.global.ytdlp && STATE.global.ytdlp.quality;
    if (def && [...sel.options].some((o) => o.value === def)) sel.value = def;
    actions.appendChild(sel);
    const dl = document.createElement("button");
    dl.className = "media-btn primary";
    dl.textContent = "Download";
    const src = primary && primary.kind !== "ytdlp" ? primary : ytd;
    dl.addEventListener("click", () => overlayDownloadFromPopup(it, src, sel.value));
    actions.appendChild(dl);
  } else if (primary && primary.kind === "hls") {
    const dl = document.createElement("button");
    dl.className = "media-btn primary";
    dl.textContent = "HLS ↗";
    dl.title = "Open the HLS downloader";
    dl.addEventListener("click", () => openHlsDownloader({ url: primary.url, title: it.title }));
    actions.appendChild(dl);
  } else if (ytd) {
    const cp = document.createElement("button");
    cp.className = "media-btn primary";
    cp.textContent = "Set up ↗";
    cp.title = "One-time setup: this site needs the ComboBreaker Helper";
    cp.addEventListener("click", async () => {
      try {
        await sendMessage({ type: "open-helper-setup" });
        window.close();
      } catch (e) {
        status(`Couldn't open setup: ${e.message}`, "err");
      }
    });
    actions.appendChild(cp);
  }

  const open = document.createElement("button");
  open.className = "media-btn";
  open.textContent = "↗";
  open.title = primary && primary.kind !== "ytdlp" ? "Open media URL in a new tab" : "Open page in a new tab";
  open.addEventListener("click", () =>
    chrome.tabs.create({ url: primary && primary.kind !== "ytdlp" ? primary.url : it.page, active: false })
  );
  actions.appendChild(open);
  row.appendChild(actions);

  const job = jobForItem(it.id);
  if (job && isJobActive(job)) {
    const p = document.createElement("div");
    p.className = "progress";
    p.innerHTML = "<i></i>";
    p.querySelector("i").style.width = `${job.percent || 0}%`;
    row.appendChild(p);
  }
  return row;
}

function placeholderThumb() {
  const d = document.createElement("div");
  d.className = "thumb empty";
  d.textContent = "▶";
  return d;
}

async function locateItem(id, frameId = 0) {
  if (!STATE.tab) return;
  try {
    const r = await chrome.tabs.sendMessage(STATE.tab.id, { type: "cb-overlay-locate", id }, { frameId: frameId || 0 });
    if (r && r.ok) status("Highlighted on page", "ok");
    else status("Couldn't find it on the page anymore", "err");
  } catch (e) {
    status(`Locate failed: ${e.message}`, "err");
  }
}

async function overlayDownloadFromPopup(it, source, quality) {
  if (!source) return;
  try {
    const direct = !["ytdlp", "hls", "dash"].includes(source.kind);
    if (direct) {
      // Same naming path as the on-page badge (service worker owns it).
      await sendMessage({
        type: "overlay-download",
        tabId: STATE.tab.id,
        item: { id: it.id, title: it.title, page: it.page, thumb: it.thumb, site: it.site },
        source: { kind: source.kind, url: source.url, res: source.res || "" },
        referer: STATE.tab.url,
      });
      status("Download started", "ok");
      return;
    }
    const bridgeOk = !!(MEDIA.bridge && MEDIA.bridge.available);
    if (!bridgeOk) {
      if (source.kind === "hls") return openHlsDownloader({ url: source.url, title: it.title });
      await sendMessage({ type: "open-helper-setup" });
      window.close();
      return;
    }
    const job = await sendMessage({
      type: "ytdlp-download",
      url: source.url,
      quality: quality || "best",
      title: it.title || "",
      tabId: STATE.tab.id,
      itemId: it.id,
      page: it.page,
      referer: STATE.tab.url,
      thumb: it.thumb,
      site: it.site,
    });
    if (job) {
      MEDIA.jobs.unshift(job);
      renderJobs();
      renderVideoProgress();
    }
    status("Download started", "ok");
  } catch (e) {
    status(`Download failed: ${e.message}`, "err");
  }
}


function renderVideoProgress() {
  for (const row of document.querySelectorAll(".media-video")) {
    const job = jobForItem(row.dataset.itemId);
    let p = row.querySelector(".progress");
    if (job && isJobActive(job)) {
      if (!p) {
        p = document.createElement("div");
        p.className = "progress";
        p.innerHTML = "<i></i>";
        row.appendChild(p);
      }
      p.querySelector("i").style.width = `${job.percent || 0}%`;
    } else if (p) {
      p.remove();
    }
  }
}

//  yt-dlp jobs

function isJobActive(j) {
  return j && (j.status === "queued" || j.status === "downloading" || j.status === "processing");
}

function jobForItem(itemId) {
  if (!itemId) return null;
  let latest = null;
  for (const j of MEDIA.jobs) {
    if (j.itemId === itemId && (!latest || (j.updated || 0) > (latest.updated || 0))) latest = j;
  }
  return latest;
}

async function loadJobs() {
  try {
    MEDIA.jobs = (await sendMessage({ type: "ytdlp-jobs" })) || [];
  } catch {
    MEDIA.jobs = [];
  }
  renderJobs();
}

function renderJobs() {
  const wrap = $("media-jobs-wrap");
  const list = $("media-jobs");
  const jobs = [...MEDIA.jobs].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  wrap.hidden = jobs.length === 0;
  list.innerHTML = "";
  for (const j of jobs.slice(0, 12)) list.appendChild(renderJobRow(j));
}

function renderJobRow(j) {
  const row = document.createElement("div");
  row.className = "media-job";
  const t = document.createElement("div");
  t.className = "jt";
  t.textContent = j.title || j.url;
  t.title = j.url || "";
  row.appendChild(t);

  const a = document.createElement("div");
  a.className = "ja";
  if (isJobActive(j)) {
    const c = document.createElement("button");
    c.className = "media-btn";
    c.textContent = "Cancel";
    c.addEventListener("click", async () => {
      c.disabled = true;
      try {
        await sendMessage({ type: "ytdlp-cancel", jobId: j.id });
      } catch (e) {
        status(`Cancel failed: ${e.message}`, "err");
      }
    });
    a.appendChild(c);
  } else if (j.status === "done" && j.filepath) {
    const f = document.createElement("button");
    f.className = "media-btn";
    f.textContent = "Folder";
    f.title = j.filepath;
    f.addEventListener("click", () => sendMessage({ type: "ytdlp-reveal", path: j.filepath }).catch(() => {}));
    a.appendChild(f);
  } else if (j.status === "error") {
    const r = document.createElement("button");
    r.className = "media-btn";
    r.textContent = "Retry";
    r.addEventListener("click", () =>
      overlayDownloadFromPopup(
        { id: j.itemId, title: j.title, page: j.page, thumb: j.thumb, site: j.site },
        { kind: "ytdlp", url: j.url },
        j.quality
      )
    );
    a.appendChild(r);
  }
  row.appendChild(a);

  const s = document.createElement("div");
  s.className = "js";
  let text = "";
  if (j.status === "queued") text = "Starting…";
  else if (j.status === "downloading") {
    const bits = [];
    if (j.percent != null) bits.push(`${Math.round(j.percent)}%`);
    if (j.total) bits.push(formatBytesShort(j.total));
    if (j.speed) bits.push(`${formatBytesShort(j.speed)}/s`);
    if (j.eta != null && j.eta > 0) bits.push(`eta ${formatDurationShort(j.eta)}`);
    text = bits.join(" · ") || "Downloading…";
  } else if (j.status === "processing") text = `Merging (${j.stage || "ffmpeg"})…`;
  else if (j.status === "done") {
    text = j.filepath || "Saved";
    s.classList.add("ok");
  } else if (j.status === "error") {
    text = j.error || "Failed";
    s.classList.add("err");
  } else if (j.status === "cancelled") text = "Cancelled";
  s.textContent = text;
  s.title = text;
  row.appendChild(s);

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.innerHTML = "<i></i>";
  if (j.status === "done") {
    bar.classList.add("done");
    bar.querySelector("i").style.width = "100%";
  } else if (j.status === "error") bar.classList.add("err");
  else if (j.status === "processing" || j.status === "queued") bar.classList.add("busy");
  else bar.querySelector("i").style.width = `${j.percent || 0}%`;
  row.appendChild(bar);
  return row;
}

function formatBytesShort(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

//  Raw URL list (network sniff + DOM scan)

async function loadRaw() {
  const list = $("media-list");
  try {
    const items = await sendMessage({ type: "media-list", tabId: STATE.tab.id });
    renderMedia(items);
  } catch (e) {
    list.innerHTML = `<div class="empty muted">Error: ${escapeHtml(String(e.message || e))}</div>`;
  }
}

function renderMedia(items) {
  const list = $("media-list");
  $("media-raw-count").textContent = items.length ? `(${items.length})` : "";
  if (!items.length) {
    list.innerHTML = `<div class="empty muted">Nothing sniffed yet. Play the video and re-open this popup.</div>`;
    return;
  }
  list.innerHTML = "";
  const sorted = [...items].sort(mediaSortKey);
  for (const it of sorted) {
    list.appendChild(renderMediaItem(it));
  }
}

function mediaSortKey(a, b) {
  const rank = (k) => {
    if (k === "mp4" || k === "webm" || k === "mov" || k === "mkv") return 0;
    if (k === "hls") return 1;
    if (k === "dash") return 2;
    return 3;
  };
  const ra = rank(a.kind);
  const rb = rank(b.kind);
  if (ra !== rb) return ra - rb;
  return (b.time || 0) - (a.time || 0);
}

function renderMediaItem(it) {
  const row = document.createElement("div");
  row.className = "media-item";

  const kind = document.createElement("span");
  kind.className = `kind ${it.kind || ""}`;
  kind.textContent = (it.kind || "?").toUpperCase();
  row.appendChild(kind);

  const info = document.createElement("div");
  info.className = "info";
  const url = document.createElement("div");
  url.className = "url";
  url.textContent = shortUrl(it.url);
  url.title = `${it.url}\n(click to copy)`;
  url.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(it.url);
      status("URL copied", "ok");
    } catch {}
  });
  info.appendChild(url);

  const meta = document.createElement("div");
  meta.className = "meta";
  if (it.width && it.height) meta.appendChild(badge(`${it.width}×${it.height}`));
  if (it.duration) meta.appendChild(badge(formatDurationShort(it.duration)));
  if (it.mime) meta.appendChild(badge(it.mime.split(";")[0]));
  meta.appendChild(badge(it.source === "dom" ? "from DOM" : "from network"));
  info.appendChild(meta);
  row.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "actions";
  const bridgeOk = !!(MEDIA.bridge && MEDIA.bridge.available);

  if (it.kind === "hls" || it.kind === "dash") {
    if (bridgeOk) {
      const dl = document.createElement("button");
      dl.className = "media-btn primary";
      dl.textContent = "Download";
      dl.title = "Download this stream through the Helper";
      dl.addEventListener("click", () =>
        overlayDownloadFromPopup(
          { id: `raw:${it.url}`, title: it.title || (STATE.tab && STATE.tab.title) || "", page: STATE.tab.url },
          { kind: it.kind, url: it.url },
          "best"
        )
      );
      actions.appendChild(dl);
    }
    if (it.kind === "hls") {
      const dl = document.createElement("button");
      dl.className = bridgeOk ? "media-btn" : "media-btn primary";
      dl.textContent = "HLS ↗";
      dl.title = "Open the in-extension HLS downloader";
      dl.addEventListener("click", () => openHlsDownloader(it));
      actions.appendChild(dl);
    } else if (!bridgeOk) {
      const note = document.createElement("button");
      note.className = "media-btn";
      note.textContent = "DASH";
      note.disabled = true;
      note.title = "DASH (.mpd) needs the Helper (set it up above).";
      actions.appendChild(note);
    }
  } else {
    const dl = document.createElement("button");
    dl.className = "media-btn primary";
    dl.textContent = "Download";
    dl.addEventListener("click", () => downloadDirect(it));
    actions.appendChild(dl);
  }

  const open = document.createElement("button");
  open.className = "media-btn";
  open.textContent = "↗";
  open.title = "Open URL in a new tab";
  open.addEventListener("click", () => chrome.tabs.create({ url: it.url, active: false }));
  actions.appendChild(open);

  row.appendChild(actions);
  return row;
}

async function downloadDirect(it) {
  try {
    await sendMessage({ type: "media-download", url: it.url });
    status("Download started", "ok");
  } catch (e) {
    status(`Download failed: ${e.message}`, "err");
  }
}

async function openHlsDownloader(it) {
  try {
    await sendMessage({
      type: "open-hls-downloader",
      url: it.url,
      title: it.title || (STATE.tab && STATE.tab.title) || "",
      referer: STATE.tab && STATE.tab.url ? STATE.tab.url : "",
    });
    window.close();
  } catch (e) {
    status(`Couldn't open downloader: ${e.message}`, "err");
  }
}

async function copyYtDlp() {
  if (!STATE.tab || !STATE.tab.url) {
    status("No tab URL", "err");
    return;
  }
  const cmd = `yt-dlp "${STATE.tab.url}"`;
  try {
    await navigator.clipboard.writeText(cmd);
    status("yt-dlp command copied", "ok");
  } catch (e) {
    status(`Copy failed: ${e.message}`, "err");
  }
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    let path = x.pathname;
    if (path.length > 60) path = "…" + path.slice(-58);
    return `${x.host}${path}`;
  } catch {
    return u;
  }
}

function formatDurationShort(s) {
  if (!s || !isFinite(s)) return "";
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

//  Browse pane (Tier 3) 

function bindBrowsePane() {
  $("browse-reader").addEventListener("click", onReaderView);
  $("browse-structured-data").addEventListener("click", onStructuredDataView);
  $("browse-md-copy").addEventListener("click", onCopyMarkdown);
  $("browse-vp-btns").addEventListener("click", onViewportPreset);
  $("browse-session-save").addEventListener("click", onSaveSession);
  $("browse-session-refresh").addEventListener("click", () => loadBrowse());
  $("browse-dup-scan").addEventListener("click", onScanDupes);
  $("browse-dup-close").addEventListener("click", onCloseDupes);
}

async function onReaderView() {
  if (!STATE.tab) return;
  try {
    const r = await sendMessage({ type: "reader-open", tabId: STATE.tab.id });
    if (r && r.ok) {
      status("Reader tab opened", "ok");
    } else {
      status((r && r.error) || "Reader could not run on this page", "err");
    }
  } catch (e) {
    status(String((e && e.message) || e), "err");
  }
}

async function onStructuredDataView() {
  if (!STATE.tab) return;
  try {
    const r = await sendMessage({ type: "structured-data-open", tabId: STATE.tab.id });
    if (r && r.ok) {
      status("Structured data viewer opened", "ok");
    } else {
      status((r && r.error) || "Could not extract structured data from this page", "err");
    }
  } catch (e) {
    status(String((e && e.message) || e), "err");
  }
}

async function onCopyMarkdown() {
  if (!STATE.tab) return;
  try {
    const r = await sendMessage({ type: "reader-extract", tabId: STATE.tab.id });
    if (!r || !r.ok) {
      status((r && r.error) || "Could not build Markdown for this page", "err");
      return;
    }
    await copyWithOptionalPermission(r.markdown);
    status("Markdown copied to clipboard", "ok");
  } catch (e) {
    status(String((e && e.message) || e), "err");
  }
}

function copyWithOptionalPermission(text) {
  return (async () => {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_) {
      // optional clipboard — ask once
    }
    await new Promise((resolve, reject) => {
      chrome.permissions.request({ permissions: ["clipboardWrite"] }, (g) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!g) {
          return reject(new Error("Clipboard permission denied"));
        }
        return resolve();
      });
    });
    await navigator.clipboard.writeText(text);
  })();
}

function onViewportPreset(e) {
  const b = e.target && e.target.closest && e.target.closest("[data-vp]");
  if (!b) return;
  (async () => {
    if (!STATE.siteKey) {
      status("Viewport presets need a normal site (not this internal URL).", "err");
      return;
    }
    const preset = b.getAttribute("data-vp");
    if (!preset) return;
    try {
      const r = await sendMessage({
        type: "set-viewport-preset",
        tabId: STATE.tab.id,
        siteKey: STATE.siteKey,
        preset,
      });
      if (r && r.strippedUa) {
        status("User-Agent override removed for this site. Reload the page to apply.", "ok");
      } else if (r && r.size) {
        status(`Window ${r.size.w}×${r.size.h} and UA set. Reload the page.`, "ok");
      } else {
        status("Viewport / UA updated", "ok");
      }
    } catch (e) {
      status(String((e && e.message) || e), "err");
    }
  })();
}

function sessionToMarkdown(s) {
  const head = `# ${s.name || "Session"}\n\nSaved: ${new Date(s.saved).toLocaleString()}\n\n`;
  return head + (s.entries || []).map((e) => {
    const t = (e.title || "").replace(/\n/g, " ");
    return `- [${t}](${e.url})`;
  }).join("\n");
}

function loadBrowse() {
  (async () => {
    const ul = $("browse-sessions");
    try {
      const { sessions = [] } = await sendMessage({ type: "list-tab-sessions" });
      if (!sessions.length) {
        ul.innerHTML = `<li class="empty muted">No saved sessions yet.</li>`;
        return;
      }
      ul.innerHTML = "";
      for (const s of sessions) {
        const li = document.createElement("li");
        li.className = "browse-session-item";
        const n = s.name || s.id;
        const when = s.saved ? new Date(s.saved).toLocaleString() : "";
        const c = (s.entries && s.entries.length) || 0;
        li.innerHTML = `<div class="browse-session-head"><span class="browse-session-name">${escapeHtml(
          n
        )}</span> <span class="browse-sub muted">${c} tab${c === 1 ? "" : "s"} · ${escapeHtml(
          when
        )}</span></div>
        <div class="browse-session-actions">
          <button type="button" class="ghost-btn" data-sid="${escapeHtml(s.id)}" data-act="restore">Open in new window</button>
          <button type="button" class="ghost-btn" data-sid="${escapeHtml(s.id)}" data-act="export">Export MD</button>
          <button type="button" class="danger-btn" data-sid="${escapeHtml(s.id)}" data-act="delete">Delete</button>
        </div>`;
        ul.appendChild(li);
      }
      ul.querySelectorAll("button[data-act]").forEach((btn) => {
        btn.addEventListener("click", () => onSessionAction(btn.getAttribute("data-sid"), btn.getAttribute("data-act")));
      });
    } catch (e) {
      ul.innerHTML = `<li class="empty muted">Error: ${escapeHtml(String((e && e.message) || e))}</li>`;
    }
  })();
}

async function onSessionAction(id, act) {
  if (!id) return;
  if (act === "delete") {
    try {
      await sendMessage({ type: "delete-tab-session", sessionId: id });
      status("Session removed", "ok");
      loadBrowse();
    } catch (e) {
      status(String((e && e.message) || e), "err");
    }
    return;
  }
  if (act === "restore") {
    try {
      const r = await sendMessage({ type: "restore-tab-session", sessionId: id });
      if (r && r.count) status(`Opened ${r.count} tab(s) in a new window`, "ok");
    } catch (e) {
      status(String((e && e.message) || e), "err");
    }
    return;
  }
  if (act === "export") {
    const { sessions = [] } = await sendMessage({ type: "list-tab-sessions" });
    const s = sessions.find((x) => x.id === id);
    if (!s) {
      status("Session not found", "err");
      return;
    }
    try {
      await copyWithOptionalPermission(sessionToMarkdown(s));
      status("Session list copied as Markdown", "ok");
    } catch (e) {
      status(String((e && e.message) || e), "err");
    }
  }
}

async function onSaveSession() {
  const name = $("browse-session-name").value.trim();
  try {
    const r = await sendMessage({ type: "save-tab-session", name: name || undefined });
    if (r && r.session) {
      status(`Saved "${r.session.name}" (${r.session.entries.length} tab(s))`, "ok");
      $("browse-session-name").value = "";
      loadBrowse();
    }
  } catch (e) {
    status(String((e && e.message) || e), "err");
  }
}

async function onScanDupes() {
  const el = $("browse-dup-list");
  el.hidden = true;
  el.innerHTML = "";
  try {
    const { groups = [] } = await sendMessage({ type: "find-duplicate-tabs" });
    if (!groups.length) {
      el.innerHTML = `<li class="empty muted">No duplicate URLs in open tabs.</li>`;
      el.hidden = false;
      return;
    }
    for (const g of groups) {
      const li = document.createElement("li");
      li.className = "browse-dup-item";
      const u = g.url;
      li.textContent = `${g.count}×  ${u.slice(0, 120)}${u.length > 120 ? "…" : ""}`;
      el.appendChild(li);
    }
    el.hidden = false;
    status(`${groups.length} URL(s) with duplicate tab(s)`, "ok");
  } catch (e) {
    el.innerHTML = `<li class="empty muted">Error: ${escapeHtml(String((e && e.message) || e))}</li>`;
    el.hidden = false;
  }
}

async function onCloseDupes() {
  if (!window.confirm("Close all duplicate tabs, keeping one per URL?")) return;
  try {
    const r = await sendMessage({ type: "close-duplicate-tabs" });
    if (r) status(`Closed ${r.closed} tab(s).`, "ok");
    loadBrowse();
    await onScanDupes();
  } catch (e) {
    status(String((e && e.message) || e), "err");
  }
}

//  Tools pane 

function bindToolsPane() {
  $("g-json").addEventListener("change", async (e) => {
    await setGlobal({ jsonFormatterEnabled: e.target.checked });
    status(`JSON formatter ${e.target.checked ? "on" : "off"}`, "ok");
  });

  document.querySelectorAll(".tool[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => onTool(btn.dataset.tool));
  });
}

async function onTool(tool) {
  try {
    switch (tool) {
      case "color-picker":
      case "ruler":
      case "whatfont":
        await sendMessage({ type: "launch-tool", tool, tabId: STATE.tab.id });
        window.close();
        break;
      case "screenshot":
        status("Capturing… (don't switch tabs)", "ok");
        await sendMessage({ type: "capture-fullpage", tabId: STATE.tab.id });
        status("Saved to Downloads", "ok");
        break;
      case "encoding":
        $("encoding-dialog").showModal();
        break;
      case "edit-css":
      case "edit-js": {
        const url = chrome.runtime.getURL(
          `options/options.html#${tool === "edit-css" ? "css" : "js"}/${encodeURIComponent(STATE.siteKey || "")}`
        );
        await chrome.tabs.create({ url });
        window.close();
        break;
      }
    }
  } catch (err) {
    status(String(err && err.message || err), "err");
  }
}

//  Dialog wiring 

function bindDialogs() {
  $("encoding-apply").addEventListener("click", async (e) => {
    e.preventDefault();
    const enc = $("encoding-select").value;
    $("encoding-dialog").close();
    try {
      await sendMessage({ type: "set-encoding", tabId: STATE.tab.id, encoding: enc });
      status(`Re-decoded as ${enc}`, "ok");
    } catch (err) {
      status(String(err), "err");
    }
  });
  $("cookie-save").addEventListener("click", saveCookie);
}

//  Plumbing 

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error("no response from service worker"));
      if (!resp.ok) return reject(new Error(resp.error || "unknown error"));
      resolve(resp.result);
    });
  });
}

function status(text, kind) {
  const el = $("status");
  el.hidden = false;
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

init().catch((err) => {
  console.error(err);
  status(String(err), "err");
});
