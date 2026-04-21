import { siteKeyFromUrl, prettySite } from "../lib/site.js";
import { getGlobal, setGlobal } from "../lib/storage.js";

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
  bindToolsPane();
  bindDialogs();
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
