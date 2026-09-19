// Redirects pane: the redirect chain the service worker recorded for this tab.

import { $, STATE, sendMessage, status, escapeHtml } from "../shared.js";

export function bindRedirectsPane() {
  $("redirects-refresh").addEventListener("click", () => loadRedirects(true));
  $("redirects-clear").addEventListener("click", clearRedirects);
  $("redirects-copy").addEventListener("click", copyRedirects);
}

let REDIRECTS_CACHE = [];

export async function loadRedirects(_force = false) {
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
