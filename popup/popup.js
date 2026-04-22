import { siteKeyFromUrl, prettySite } from "../lib/site.js";
import { getGlobal, setGlobal } from "../lib/storage.js";
import { initUtilities } from "./utilities.js";

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
  $("g-adblock").checked = !!STATE.global.adblockEnabled;
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
  if (STATE.tab && STATE.tab.id != null) {
    try {
      const bp = chrome.runtime.connect({ name: "browsing-popup" });
      bp.postMessage({ type: "active-tab", tabId: STATE.tab.id, noCache: true });
    } catch (_) {
      // ignore
    }
  }
}

// ─────────────────── Tab routing ───────────────────

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

// ─────────────────── Site pane ───────────────────

function renderSiteToggles() {
  const s = STATE.settings;
  $("t-js").checked = !!STATE.jsEnabled;
  $("t-css").checked = !!s.cssEnabled;
  $("t-userjs").checked = !!s.jsEnabled;
  renderDarkOverride(s.darkMode);
}

function renderDarkOverride(value) {
  const norm = value === "on" || value === "off" ? value : "";
  document
    .querySelectorAll(".site-override .seg-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.val === norm));
}

function disableSiteToggles(reason) {
  for (const id of ["t-js", "t-css", "t-userjs"]) $(id).disabled = true;
  document
    .querySelectorAll(".site-override .seg-btn")
    .forEach((b) => (b.disabled = true));
  status(reason, "err");
}

function bindSitePane() {
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
    status(`Custom CSS ${enabled ? "on" : "off"}. Reload to apply.`, "ok");
  });

  $("t-userjs").addEventListener("change", async (e) => {
    if (!STATE.siteKey) return;
    const enabled = e.target.checked;
    await sendMessage({ type: "set-site", siteKey: STATE.siteKey, patch: { jsEnabled: enabled } });
    status(`Custom JS ${enabled ? "on" : "off"}. Reload to apply.`, "ok");
  });

  document.querySelectorAll('[data-tool="edit-css"], [data-tool="edit-js"]').forEach((b) =>
    b.addEventListener("click", () => onTool(b.dataset.tool))
  );
}

// ─────────────────── Dark mode controls ───────────────────

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

// ─────────────────── Cookies pane ───────────────────
// Uses chrome.cookies directly (popup has the permission).

let COOKIES_CACHE = [];

function bindCookiesPane() {
  $("cookies-refresh").addEventListener("click", () => loadCookies(true));
  $("cookies-nuke").addEventListener("click", nukeCookies);
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

// ─────────────────── Headers pane ───────────────────

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

// ─────────────────── Redirects pane ───────────────────

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

// ─────────────────── Media pane ───────────────────

const YT_HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
]);

function isYouTubeTab() {
  if (!STATE.tab || !STATE.tab.url) return false;
  try {
    let host = new URL(STATE.tab.url).hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return YT_HOSTS.has(host);
  } catch {
    return false;
  }
}

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
      status("Media list cleared", "ok");
      loadMedia(true);
    } catch (e) {
      status(`Clear failed: ${e.message}`, "err");
    }
  });
  $("media-ytdlp").addEventListener("click", copyYtDlp);
}

async function loadMedia(_force = false) {
  if (!STATE.tab) return;
  $("media-yt-banner").hidden = !isYouTubeTab();
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
  $("media-count").textContent = items.length
    ? `${items.length} item${items.length === 1 ? "" : "s"}`
    : "—";
  if (!items.length) {
    list.innerHTML = `<div class="empty muted">Nothing detected yet. Play the video and re-open this popup.</div>`;
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

  if (it.kind === "hls") {
    const dl = document.createElement("button");
    dl.className = "media-btn primary";
    dl.textContent = "Open ↗";
    dl.title = "Open the HLS downloader in a new tab";
    dl.addEventListener("click", () => openHlsDownloader(it));
    actions.appendChild(dl);
  } else if (it.kind === "dash") {
    const note = document.createElement("button");
    note.className = "media-btn";
    note.textContent = "DASH";
    note.disabled = true;
    note.title = "DASH (.mpd) downloads aren't implemented yet — use yt-dlp.";
    actions.appendChild(note);
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

// ─────────────────── Browse pane (Tier 3) ───────────────────

function bindBrowsePane() {
  $("browse-reader").addEventListener("click", onReaderView);
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
    if (r && r.ok) status("Reader tab opened", "ok");
    else status((r && r.error) || "Reader could not run on this page", "err");
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
      status(`Saved “${r.session.name}” (${r.session.entries.length} tab(s))`, "ok");
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

// ─────────────────── Tools pane ───────────────────

function bindToolsPane() {
  $("g-adblock").addEventListener("change", async (e) => {
    await setGlobal({ adblockEnabled: e.target.checked });
    await sendMessage({ type: "apply-adblock" });
    status(`Adblock ${e.target.checked ? "enabled" : "disabled"}`, "ok");
  });
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

// ─────────────────── Dialog wiring ───────────────────

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

// ─────────────────── Plumbing ───────────────────

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
