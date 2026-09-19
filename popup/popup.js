import { siteKeyFromUrl, prettySite } from "../lib/site.js";
import { getGlobal, setGlobal } from "../lib/storage.js";
import { initUtilities } from "./utilities.js";
import { initSnippets } from "./snippets.js";
import { initStorageView } from "./storage_view.js";
import { $, STATE, sendMessage, status, debounce } from "./shared.js";
import { bindCookiesPane, loadCookies } from "./panes/cookies.js";
import { bindHeadersPane, loadHeaders } from "./panes/headers.js";
import { bindRedirectsPane, loadRedirects } from "./panes/redirects.js";
import { bindMediaPane, loadMedia } from "./panes/media.js";
import { bindBrowsePane, loadBrowse } from "./panes/browse.js";



async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  STATE.tab = tab;
  STATE.siteKey = siteKeyFromUrl(tab?.url);

  $("site-name").textContent = prettySite(STATE.siteKey);

  STATE.global = await getGlobal();
  renderAdblockLevel(STATE.global.adblockLevel);
  loadBlockedSummary();
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
  initStorageView({ tab: STATE.tab, siteKey: STATE.siteKey, status });
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

// Blocked since this tab's last navigation. Names come from the Basic list;
// the Strong list only reports a count (see adblockMatched in the worker).
async function loadBlockedSummary() {
  const el = $("adblock-summary");
  el.hidden = true;
  if (!STATE.tab || STATE.tab.id == null || STATE.global.adblockLevel === "off") return;
  let m;
  try {
    m = await sendMessage({ type: "adblock-matched", tabId: STATE.tab.id });
  } catch {
    return; // getMatchedRules quota; the toolbar badge still shows the number
  }
  if (!m) return;
  el.textContent = "";
  const b = document.createElement("b");
  b.textContent = String(m.total);
  el.append(b, ` request${m.total === 1 ? "" : "s"} blocked on this page`);
  const parts = m.basic.slice(0, 4).map((x) => (x.count > 1 ? `${x.name} ×${x.count}` : x.name));
  const rest = m.basic.slice(4).reduce((n, x) => n + x.count, 0) + m.strong;
  if (parts.length && rest) parts.push(`${rest} more`);
  if (parts.length) el.append(`: ${parts.join(", ")}`);
  el.hidden = false;
}

function bindAdblock() {
  document.querySelectorAll(".adblock-level .seg-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const level = btn.dataset.level;
      await setGlobal({ adblockLevel: level });
      await sendMessage({ type: "apply-adblock" });
      STATE.global.adblockLevel = level;
      renderAdblockLevel(level);
      loadBlockedSummary();
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

// "Built with" chips. Best effort: restricted pages and blocked-JS sites just
// show nothing.
async function loadTechStack() {
  if (!STATE.siteKey || STATE.siteKey === "file://" || STATE.tab?.id == null) return;
  let tech;
  try {
    tech = await sendMessage({ type: "detect-tech", tabId: STATE.tab.id });
  } catch {
    return;
  }
  if (!tech || !tech.length) return;
  const chips = $("tech-chips");
  chips.textContent = "";
  for (const t of tech) {
    const chip = document.createElement("span");
    chip.className = `tech-chip ${t.cat}`;
    chip.title = t.cat;
    chip.textContent = t.name;
    if (t.version) {
      const v = document.createElement("small");
      v.textContent = t.version;
      chip.appendChild(v);
    }
    chips.appendChild(chip);
  }
  $("tech-stack").hidden = false;
}

function bindSitePane() {
  bindTips();
  loadTechStack();
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
      case "trackers":
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
}

//  Plumbing 




init().catch((err) => {
  console.error(err);
  status(String(err), "err");
});
