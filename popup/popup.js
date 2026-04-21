import { siteKeyFromUrl, prettySite } from "../lib/site.js";
import { getGlobal, setGlobal, setSite } from "../lib/storage.js";

const $ = (id) => document.getElementById(id);

let CURRENT = { tab: null, siteKey: null, settings: null, global: null, jsEnabled: true };

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  CURRENT.tab = tab;
  CURRENT.siteKey = siteKeyFromUrl(tab?.url);

  $("site-name").textContent = prettySite(CURRENT.siteKey);
  if (!CURRENT.siteKey) {
    disableSiteToggles("Per-site features need an http(s) page.");
  }

  CURRENT.global = await getGlobal();
  $("g-adblock").checked = !!CURRENT.global.adblockEnabled;
  $("g-json").checked = !!CURRENT.global.jsonFormatterEnabled;

  if (CURRENT.siteKey) {
    const state = await sendMessage({ type: "get-site-state", siteKey: CURRENT.siteKey });
    CURRENT.settings = state.settings;
    CURRENT.jsEnabled = state.jsEnabled;
    renderSiteToggles();
  }

  bindEvents();
}

function renderSiteToggles() {
  const s = CURRENT.settings;
  const dark = s.darkMode == null ? CURRENT.global.defaultDarkMode : s.darkMode;
  $("t-darkmode").checked = !!dark;
  $("t-js").checked = !!CURRENT.jsEnabled;
  $("t-css").checked = !!s.cssEnabled;
  $("t-userjs").checked = !!s.jsEnabled;
}

function disableSiteToggles(reason) {
  for (const id of ["t-darkmode", "t-js", "t-css", "t-userjs"]) {
    $(id).disabled = true;
  }
  status(reason, "err");
}

function bindEvents() {
  $("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  $("t-darkmode").addEventListener("change", async (e) => {
    if (!CURRENT.siteKey) return;
    const enabled = e.target.checked;
    await sendMessage({
      type: "set-site",
      siteKey: CURRENT.siteKey,
      patch: { darkMode: enabled },
    });
    chrome.tabs.sendMessage(CURRENT.tab.id, {
      type: "cb-dark-mode-changed",
      enabled,
    }).catch(() => {});
    status(`Dark mode ${enabled ? "on" : "off"} for ${CURRENT.siteKey}`, "ok");
  });

  $("t-js").addEventListener("change", async (e) => {
    if (!CURRENT.siteKey) return;
    const enabled = e.target.checked;
    await sendMessage({
      type: "set-js-enabled",
      siteKey: CURRENT.siteKey,
      enabled,
    });
    status(`JS ${enabled ? "enabled" : "blocked"}. Reloading…`, "ok");
    setTimeout(() => chrome.tabs.reload(CURRENT.tab.id), 250);
  });

  $("t-css").addEventListener("change", async (e) => {
    if (!CURRENT.siteKey) return;
    const enabled = e.target.checked;
    const updated = await sendMessage({
      type: "set-site",
      siteKey: CURRENT.siteKey,
      patch: { cssEnabled: enabled },
    });
    CURRENT.settings = updated.result || updated;
    if (enabled && !CURRENT.settings.css) {
      status("CSS enabled — open editor to add styles", "ok");
    } else {
      status(`Custom CSS ${enabled ? "on" : "off"}. Reload to apply.`, "ok");
    }
  });

  $("t-userjs").addEventListener("change", async (e) => {
    if (!CURRENT.siteKey) return;
    const enabled = e.target.checked;
    const updated = await sendMessage({
      type: "set-site",
      siteKey: CURRENT.siteKey,
      patch: { jsEnabled: enabled },
    });
    CURRENT.settings = updated.result || updated;
    status(`Custom JS ${enabled ? "on" : "off"}. Reload to apply.`, "ok");
  });

  $("g-adblock").addEventListener("change", async (e) => {
    await setGlobal({ adblockEnabled: e.target.checked });
    await sendMessage({ type: "apply-adblock" });
    status(`Adblock ${e.target.checked ? "enabled" : "disabled"}`, "ok");
  });

  $("g-json").addEventListener("change", async (e) => {
    await setGlobal({ jsonFormatterEnabled: e.target.checked });
    status(`JSON formatter ${e.target.checked ? "on" : "off"}`, "ok");
  });

  document.querySelectorAll(".tool").forEach((btn) => {
    btn.addEventListener("click", () => onTool(btn.dataset.tool));
  });

  $("encoding-apply").addEventListener("click", async (e) => {
    e.preventDefault();
    const enc = $("encoding-select").value;
    $("encoding-dialog").close();
    try {
      await sendMessage({ type: "set-encoding", tabId: CURRENT.tab.id, encoding: enc });
      status(`Re-decoded as ${enc}`, "ok");
    } catch (err) {
      status(String(err), "err");
    }
  });
}

async function onTool(tool) {
  try {
    switch (tool) {
      case "color-picker":
      case "ruler":
      case "whatfont":
        await sendMessage({ type: "launch-tool", tool, tabId: CURRENT.tab.id });
        window.close();
        break;
      case "screenshot":
        status("Capturing… (don't switch tabs)", "ok");
        await sendMessage({ type: "capture-fullpage", tabId: CURRENT.tab.id });
        status("Saved to Downloads", "ok");
        break;
      case "encoding":
        $("encoding-dialog").showModal();
        break;
      case "edit-css":
      case "edit-js": {
        const url = chrome.runtime.getURL(
          `options/options.html#${tool === "edit-css" ? "css" : "js"}/${encodeURIComponent(CURRENT.siteKey || "")}`
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

init().catch((err) => {
  console.error(err);
  status(String(err), "err");
});
