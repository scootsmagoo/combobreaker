import {
  getGlobal,
  setGlobal,
  getSite,
  setSite,
  listSites,
  deleteSite,
} from "../lib/storage.js";

const $ = (id) => document.getElementById(id);

const STATE = {
  sites: [],
  activeSite: null,
  activeTab: "css",
  activeSettings: null,
  dirty: false,
};

async function init() {
  $("version").textContent = "v" + chrome.runtime.getManifest().version;

  const g = await getGlobal();
  $("g-adblock").checked = !!g.adblockEnabled;
  $("g-json").checked = !!g.jsonFormatterEnabled;
  $("g-darkmode").checked = !!g.darkMode.enabled;
  renderDarkTuneInputs(g.darkMode.theme);

  $("g-adblock").addEventListener("change", async (e) => {
    await setGlobal({ adblockEnabled: e.target.checked });
    chrome.runtime.sendMessage({ type: "apply-adblock" });
    toast(`Adblock ${e.target.checked ? "on" : "off"}`, "ok");
  });
  $("g-json").addEventListener("change", async (e) => {
    await setGlobal({ jsonFormatterEnabled: e.target.checked });
    toast(`JSON formatter ${e.target.checked ? "on" : "off"}`, "ok");
  });
  $("g-darkmode").addEventListener("change", async (e) => {
    await setGlobal({ darkMode: { enabled: e.target.checked } });
    toast(`Dark mode ${e.target.checked ? "on" : "off"} for all sites`, "ok");
  });

  bindDarkTuneInputs();

  await refreshSites();

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  $("save").addEventListener("click", saveActive);
  $("delete").addEventListener("click", deleteActive);
  $("enabled-toggle").addEventListener("change", () => {
    STATE.dirty = true;
  });
  $("css-area").addEventListener("input", () => (STATE.dirty = true));
  $("js-area").addEventListener("input", () => (STATE.dirty = true));
  $("meta-dark").addEventListener("change", () => (STATE.dirty = true));

  $("add-site").addEventListener("click", () => {
    $("add-site-input").value = "";
    $("add-site-dialog").showModal();
    $("add-site-input").focus();
  });
  $("add-site-confirm").addEventListener("click", (e) => {
    e.preventDefault();
    const v = $("add-site-input").value.trim().toLowerCase();
    $("add-site-dialog").close();
    if (!v) return;
    const cleaned = v.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned)) {
      toast("Invalid hostname", "err");
      return;
    }
    selectSite(cleaned, true);
  });

  window.addEventListener("beforeunload", (e) => {
    if (STATE.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  parseHash();
  window.addEventListener("hashchange", parseHash);
}

function parseHash() {
  const h = location.hash.replace(/^#/, "");
  if (!h) return;
  const [tab, site] = h.split("/");
  if (tab && ["css", "js", "meta"].includes(tab)) STATE.activeTab = tab;
  if (site) selectSite(decodeURIComponent(site));
  switchTab(STATE.activeTab);
}

async function refreshSites() {
  STATE.sites = await listSites();
  renderSites();
}

function renderSites() {
  const list = $("site-list");
  list.innerHTML = "";
  if (STATE.sites.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No sites configured yet.";
    list.appendChild(li);
    return;
  }
  for (const { siteKey, settings } of STATE.sites) {
    const li = document.createElement("li");
    if (siteKey === STATE.activeSite) li.classList.add("active");
    const name = document.createElement("span");
    name.textContent = siteKey;
    const badges = document.createElement("span");
    badges.className = "badges";
    if (settings.cssEnabled) badges.appendChild(badge("CSS"));
    if (settings.jsEnabled) badges.appendChild(badge("JS"));
    if (settings.darkMode === "on") badges.appendChild(badge("DARK ON"));
    else if (settings.darkMode === "off") badges.appendChild(badge("DARK OFF"));
    li.appendChild(name);
    li.appendChild(badges);
    li.addEventListener("click", () => selectSite(siteKey));
    list.appendChild(li);
  }
}

function badge(text) {
  const b = document.createElement("span");
  b.className = "badge on";
  b.textContent = text;
  return b;
}

async function selectSite(siteKey, isNew = false) {
  if (STATE.dirty) {
    if (!confirm("You have unsaved changes. Discard them?")) return;
    STATE.dirty = false;
  }
  STATE.activeSite = siteKey;
  STATE.activeSettings = await getSite(siteKey);
  $("editor-site").textContent = siteKey + (isNew ? "  (new — unsaved)" : "");
  $("css-area").value = STATE.activeSettings.css || "";
  $("js-area").value = STATE.activeSettings.js || "";
  const dm = STATE.activeSettings.darkMode;
  $("meta-dark").value = dm === "on" || dm === "off" ? dm : "";
  updateEnabledToggle();
  renderSites();
}

function updateEnabledToggle() {
  if (!STATE.activeSettings) return;
  if (STATE.activeTab === "css") {
    $("enabled-toggle").checked = !!STATE.activeSettings.cssEnabled;
    $("enabled-label").textContent = "CSS enabled";
    $("enabled-toggle").disabled = false;
  } else if (STATE.activeTab === "js") {
    $("enabled-toggle").checked = !!STATE.activeSettings.jsEnabled;
    $("enabled-label").textContent = "JS enabled";
    $("enabled-toggle").disabled = false;
  } else {
    $("enabled-toggle").disabled = true;
    $("enabled-label").textContent = "—";
  }
}

function switchTab(tab) {
  STATE.activeTab = tab;
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
  $("pane-css").hidden = tab !== "css";
  $("pane-js").hidden = tab !== "js";
  $("pane-meta").hidden = tab !== "meta";
  if (tab === "meta") refreshStorageBytes();
  if (STATE.activeSettings) updateEnabledToggle();
}

async function refreshStorageBytes() {
  const bytes = await new Promise((res) =>
    chrome.storage.sync.getBytesInUse(null, (b) => res(b))
  );
  $("storage-bytes").textContent = formatBytes(bytes);
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(1)} KB`;
}

async function saveActive() {
  if (!STATE.activeSite) return;
  const enabled = $("enabled-toggle").checked;
  const patch = {};
  if (STATE.activeTab === "css") {
    patch.css = $("css-area").value;
    patch.cssEnabled = enabled;
  } else if (STATE.activeTab === "js") {
    patch.js = $("js-area").value;
    patch.jsEnabled = enabled;
  }
  const meta = $("meta-dark").value;
  patch.darkMode = meta === "on" || meta === "off" ? meta : null;
  STATE.activeSettings = await setSite(STATE.activeSite, patch);
  STATE.dirty = false;
  await refreshSites();
  selectSite(STATE.activeSite);
  toast("Saved", "ok");

  broadcastSiteChange(STATE.activeSite, STATE.activeSettings);
}

async function broadcastSiteChange(siteKey, settings) {
  // Per-site dark-mode and other persisted settings are picked up
  // automatically by site_injector via chrome.storage.onChanged.
  // We still hot-reload CSS so users iterating in the editor get
  // instant feedback without a tab refresh.
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.url || !t.id) continue;
    let host;
    try {
      host = new URL(t.url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (host !== siteKey) continue;
    chrome.tabs
      .sendMessage(t.id, {
        type: "cb-css-changed",
        css: settings.css,
        enabled: settings.cssEnabled,
      })
      .catch(() => {});
  }
}

async function deleteActive() {
  if (!STATE.activeSite) return;
  if (!confirm(`Delete all settings for ${STATE.activeSite}?`)) return;
  await deleteSite(STATE.activeSite);
  STATE.activeSite = null;
  STATE.activeSettings = null;
  STATE.dirty = false;
  $("css-area").value = "";
  $("js-area").value = "";
  $("editor-site").textContent = "Pick a site →";
  await refreshSites();
  toast("Deleted", "ok");
}

// ─────────────────── Dark-mode tuning ───────────────────

const DM_FIELDS = [
  ["brightness", "dm-brightness", "dm-brightness-out", 100],
  ["contrast", "dm-contrast", "dm-contrast-out", 100],
  ["sepia", "dm-sepia", "dm-sepia-out", 0],
  ["grayscale", "dm-grayscale", "dm-grayscale-out", 0],
];

function renderDarkTuneInputs(theme) {
  $("dm-mode").value = String(theme.mode ?? 1);
  for (const [field, inputId, outId] of DM_FIELDS) {
    $(inputId).value = String(theme[field]);
    $(outId).textContent = String(theme[field]);
  }
}

function bindDarkTuneInputs() {
  const push = debounce(async (patch) => {
    await setGlobal({ darkMode: { theme: patch } });
  }, 120);

  $("dm-mode").addEventListener("change", (e) => {
    push({ mode: Number(e.target.value) });
  });

  for (const [field, inputId, outId] of DM_FIELDS) {
    $(inputId).addEventListener("input", (e) => {
      const v = Number(e.target.value);
      $(outId).textContent = String(v);
      push({ [field]: v });
    });
  }

  $("dm-reset").addEventListener("click", async () => {
    const defaults = { brightness: 100, contrast: 100, sepia: 0, grayscale: 0, mode: 1 };
    renderDarkTuneInputs(defaults);
    await setGlobal({ darkMode: { theme: defaults } });
    toast("Dark mode tuning reset", "ok");
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let toastTimer = null;
function toast(text, kind) {
  const t = $("toast");
  t.hidden = false;
  t.className = "toast" + (kind ? " " + kind : "");
  t.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

init().catch((err) => {
  console.error(err);
  toast(String(err), "err");
});
