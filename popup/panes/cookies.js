// Cookies pane (the Cookies tab; popup/storage_view.js is its localStorage / sessionStorage half).

import { $, STATE, sendMessage, status, escapeHtml, badge } from "../shared.js";

// Uses chrome.cookies directly (popup has the permission).

let COOKIES_CACHE = [];

export function bindCookiesPane() {
  $("cookies-refresh").addEventListener("click", () => loadCookies(true));
  $("cookies-nuke").addEventListener("click", nukeCookies);
  $("site-data-nuke").addEventListener("click", nukeSiteData);
  $("cookie-save").addEventListener("click", saveCookie);
}

export async function loadCookies(force = false) {
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
