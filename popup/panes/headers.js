// Headers pane: the main document's response headers plus a summary of this site's overrides.

import { $, STATE, sendMessage, status, escapeHtml } from "../shared.js";
import { buildCurl } from "../../lib/curl.js";

let LAST = { url: "", overrides: [] }; // what Copy cURL works from

export function bindHeadersPane() {
  $("headers-refresh").addEventListener("click", () => loadHeaders(true));
  $("headers-curl").addEventListener("click", async () => {
    const cmd = buildCurl(LAST.url || (STATE.tab && STATE.tab.url), { userAgent: navigator.userAgent, overrides: LAST.overrides });
    if (!cmd) return status("cURL needs an http(s) page.", "err");
    await navigator.clipboard.writeText(cmd);
    status("curl command copied (no cookies included)", "ok");
  });
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

export async function loadHeaders(_force = false) {
  if (!STATE.tab) return;
  const list = $("headers-list");
  list.innerHTML = `<div class="empty muted">Loading…</div>`;
  try {
    const [entry, settings] = await Promise.all([
      sendMessage({ type: "get-response-headers", tabId: STATE.tab.id }),
      STATE.siteKey ? sendMessage({ type: "get-site-state", siteKey: STATE.siteKey }) : Promise.resolve(null),
    ]);
    LAST = { url: (entry && entry.url) || "", overrides: (settings && settings.settings.requestHeaders) || [] };
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
