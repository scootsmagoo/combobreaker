// Browse pane: reader view, SEO / structured data, viewport presets, tab sessions, duplicate tabs.

import { $, STATE, sendMessage, status, escapeHtml } from "../shared.js";

export function bindBrowsePane() {
  $("link-select-options").addEventListener("click", async () => {
    await sendMessage({ type: "open-options", section: "link-select" });
    window.close();
  });
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

const TRIGGER_TEXT = { z: "hold Z and drag", shift: "hold Shift and drag", alt: "hold Alt and drag", right: "drag with the right mouse button" };
const RELEASE_TEXT = { tabs: "open them in background tabs", window: "open them in a new window", copy: "copy them" };

// Asks the content script in the tab whether link select is alive there. No
// answer means it never loaded: a tab from before the extension was
// (re)loaded, or a page Chrome keeps extensions out of.
async function loadLinkSelectStatus() {
  const el = $("link-select-status");
  if (!STATE.tab || STATE.tab.id == null) return;
  let pong = null;
  try {
    pong = await chrome.tabs.sendMessage(STATE.tab.id, { type: "cb-link-select-ping" }, { frameId: 0 });
  } catch (_) {
    // no listener in that tab
  }
  if (!pong) {
    el.textContent = STATE.siteKey
      ? "Not running in this tab yet: it was open before ComboBreaker was loaded or updated. Refresh the page."
      : "Not available here: Chrome keeps extensions off its own pages (new tab, settings, the Web Store).";
    el.classList.add("warn");
    return;
  }
  el.classList.toggle("warn", !pong.enabled);
  el.textContent = pong.enabled
    ? `Ready on this page: ${TRIGGER_TEXT[pong.trigger]} over a group of links to ${RELEASE_TEXT[pong.action]}. While dragging: T tabs, W window, C copy, S smart select, Esc cancel.`
    : "Switched off in settings.";
}

export function loadBrowse() {
  loadLinkSelectStatus();
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
