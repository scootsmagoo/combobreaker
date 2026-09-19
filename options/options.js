import {
  getGlobal,
  setGlobal,
  getSite,
  setSite,
  listSites,
  deleteSite,
} from "../lib/storage.js";
import { exportAll, importAll } from "../lib/backup.js";
import { helperInstallCommand } from "../lib/helper.js";

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
  $("g-adblock-level").value = g.adblockLevel;
  $("g-adblock-badge").checked = !!g.adblockBadge;
  $("g-json").checked = !!g.jsonFormatterEnabled;
  $("g-darkmode").checked = !!g.darkMode.enabled;
  $("g-darkmode-detect").checked = !!g.darkMode.detectDark;
  renderDarkTuneInputs(g.darkMode.theme);

  $("g-adblock-level").addEventListener("change", async (e) => {
    await setGlobal({ adblockLevel: e.target.value });
    chrome.runtime.sendMessage({ type: "apply-adblock" });
    toast(`Ad blocking: ${e.target.value}`, "ok");
  });
  $("g-adblock-badge").addEventListener("change", async (e) => {
    await setGlobal({ adblockBadge: e.target.checked });
    chrome.runtime.sendMessage({ type: "apply-adblock" });
    toast(`Blocked count ${e.target.checked ? "shown" : "hidden"}`, "ok");
  });
  $("g-json").addEventListener("change", async (e) => {
    await setGlobal({ jsonFormatterEnabled: e.target.checked });
    toast(`JSON formatter ${e.target.checked ? "on" : "off"}`, "ok");
  });
  $("g-darkmode").addEventListener("change", async (e) => {
    await setGlobal({ darkMode: { enabled: e.target.checked } });
    toast(`Dark mode ${e.target.checked ? "on" : "off"} for all sites`, "ok");
  });

  $("g-darkmode-detect").addEventListener("change", async (e) => {
    await setGlobal({ darkMode: { detectDark: e.target.checked } });
    toast(e.target.checked ? "Auto skips sites that are already dark" : "Auto darkens every site", "ok");
  });

  bindDarkTuneInputs();
  bindDownloads(g);
  bindBackup();
  refreshUserScriptsStatus();

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
  $("meta-overlay").addEventListener("change", () => (STATE.dirty = true));
  $("meta-adblock").addEventListener("change", () => (STATE.dirty = true));
  for (const id of ["meta-autoclear", "meta-3p-cookies", "meta-referrer"]) {
    $(id).addEventListener("change", () => (STATE.dirty = true));
  }

  $("add-req-header").addEventListener("click", () => addHeaderRow("req"));
  $("add-res-header").addEventListener("click", () => addHeaderRow("res"));

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
  if (h === "downloads") {
    $("downloads").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const [tab, site] = h.split("/");
  if (tab && ["css", "js", "headers", "meta"].includes(tab)) STATE.activeTab = tab;
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
    if (settings.adblockPaused) badges.appendChild(badge("ADS ALLOWED"));
    if (settings.mediaOverlay === false) badges.appendChild(badge("NO BADGES"));
    else if (settings.mediaOverlay === true) badges.appendChild(badge("BADGES"));
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
  const mo = STATE.activeSettings.mediaOverlay;
  $("meta-overlay").value = mo === true ? "on" : mo === false ? "off" : "";
  $("meta-adblock").value = STATE.activeSettings.adblockPaused ? "paused" : "";
  $("meta-autoclear").value = STATE.activeSettings.autoClear ? "on" : "";
  $("meta-3p-cookies").value = STATE.activeSettings.blockThirdPartyCookies ? "on" : "";
  $("meta-referrer").value = STATE.activeSettings.referrerPolicy || "";
  $("headers-site-label").textContent = siteKey;
  renderHeaderRules("req", STATE.activeSettings.requestHeaders || []);
  renderHeaderRules("res", STATE.activeSettings.responseHeaders || []);
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
  $("pane-headers").hidden = tab !== "headers";
  $("pane-meta").hidden = tab !== "meta";
  if (tab === "meta") refreshStorageBytes();
  if (STATE.activeSettings) updateEnabledToggle();
}

async function refreshStorageBytes() {
  const bytes = await new Promise((res) =>
    chrome.storage.sync.getBytesInUse(null, (b) => res(b))
  );
  $("storage-bytes").textContent = formatBytes(bytes);
  const local = await chrome.storage.local.get(null);
  const codeBytes = Object.keys(local)
    .filter((k) => k.startsWith("sitecode:"))
    .reduce((n, k) => n + new Blob([JSON.stringify(local[k])]).size, 0);
  $("storage-bytes-local").textContent = formatBytes(codeBytes);
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(1)} KB`;
}

async function saveActive() {
  if (!STATE.activeSite) return;
  const enabled = $("enabled-toggle").checked;
  const patch = {};
  // Both bodies are saved whichever tab is showing, so an edit on the other
  // tab isn't silently dropped. The enable toggle belongs to the active tab.
  patch.css = $("css-area").value;
  patch.js = $("js-area").value;
  if (STATE.activeTab === "css") patch.cssEnabled = enabled;
  else if (STATE.activeTab === "js") patch.jsEnabled = enabled;
  const meta = $("meta-dark").value;
  patch.darkMode = meta === "on" || meta === "off" ? meta : null;
  patch.adblockPaused = $("meta-adblock").value === "paused";
  patch.autoClear = $("meta-autoclear").value === "on";
  patch.blockThirdPartyCookies = $("meta-3p-cookies").value === "on";
  patch.referrerPolicy = $("meta-referrer").value;
  const mo = $("meta-overlay").value;
  patch.mediaOverlay = mo === "on" ? true : mo === "off" ? false : null;
  // Headers are read straight off the DOM each save so unsaved row edits
  // outside the active tab don't get lost.
  patch.requestHeaders = readHeaderRules("req");
  patch.responseHeaders = readHeaderRules("res");
  STATE.activeSettings = await setSite(STATE.activeSite, patch);
  STATE.dirty = false;
  await refreshSites();
  selectSite(STATE.activeSite);
  toast("Saved", "ok");

  broadcastSiteChange(STATE.activeSite, STATE.activeSettings);
  chrome.runtime
    .sendMessage({ type: "apply-site-headers", siteKey: STATE.activeSite })
    .catch(() => {});
  chrome.runtime.sendMessage({ type: "apply-adblock" }).catch(() => {});
  chrome.runtime.sendMessage({ type: "apply-auto-clear" }).catch(() => {});
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
  const removedSite = STATE.activeSite;
  await deleteSite(removedSite);
  STATE.activeSite = null;
  STATE.activeSettings = null;
  STATE.dirty = false;
  $("css-area").value = "";
  $("js-area").value = "";
  $("req-headers").innerHTML = "";
  $("res-headers").innerHTML = "";
  $("editor-site").textContent = "Pick a site →";
  await refreshSites();
  toast("Deleted", "ok");

  // Tear down any DNR rules we created for this site.
  chrome.runtime
    .sendMessage({ type: "apply-site-headers", siteKey: removedSite })
    .catch(() => {});
}

// ─────────────────── Backup / userScripts status ───────────────────

function bindBackup() {
  $("backup-export").addEventListener("click", async () => {
    const data = await exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `combobreaker-backup-${data.exportedAt.slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Exported ${Object.keys(data.sites).length} site(s)`, "ok");
  });
  $("backup-import").addEventListener("click", () => $("backup-file").click());
  $("backup-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const res = await importAll(JSON.parse(await file.text()));
      for (const siteKey of res.sites) {
        chrome.runtime.sendMessage({ type: "apply-site-headers", siteKey }).catch(() => {});
      }
      chrome.runtime.sendMessage({ type: "apply-adblock" }).catch(() => {});
      toast(`Imported ${res.sites.length} site(s) — reloading`, "ok");
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      toast(`Import failed: ${err.message || err}`, "err");
    }
  });
}

async function refreshUserScriptsStatus() {
  const el = $("us-status");
  let available = false;
  try {
    const r = await chrome.runtime.sendMessage({ type: "userscripts-status" });
    available = !!(r && r.ok && r.result.available);
  } catch {}
  el.hidden = false;
  el.textContent = available
    ? "Runs through chrome.userScripts: works even on sites with a strict Content-Security-Policy."
    : "Heads-up: \"Allow User Scripts\" is off for ComboBreaker (chrome://extensions → Details). Your JS still runs, but slightly later and not on sites with a strict Content-Security-Policy (GitHub, X, banks). Turn the switch on for full coverage.";
  el.classList.toggle("warn", !available);
}

// ─────────────────── Header rules editor ───────────────────

const HEADER_OPS = ["set", "append", "remove"];

function renderHeaderRules(kind, rules) {
  const container = $(kind === "req" ? "req-headers" : "res-headers");
  container.innerHTML = "";
  for (const r of rules) container.appendChild(buildHeaderRow(kind, r));
}

function addHeaderRow(kind) {
  const container = $(kind === "req" ? "req-headers" : "res-headers");
  container.appendChild(buildHeaderRow(kind, { name: "", op: "set", value: "" }));
  STATE.dirty = true;
}

function buildHeaderRow(kind, rule) {
  const row = document.createElement("div");
  row.className = "header-rule";

  const name = document.createElement("input");
  name.type = "text";
  name.className = "h-name";
  name.placeholder = kind === "req" ? "User-Agent" : "X-Frame-Options";
  name.value = rule.name || "";
  name.spellcheck = false;
  name.addEventListener("input", () => (STATE.dirty = true));

  const op = document.createElement("select");
  op.className = "h-op";
  for (const o of HEADER_OPS) {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o;
    op.appendChild(opt);
  }
  op.value = HEADER_OPS.includes(rule.op) ? rule.op : "set";

  const value = document.createElement("input");
  value.type = "text";
  value.className = "h-value";
  value.placeholder = "value";
  value.value = rule.value || "";
  value.spellcheck = false;
  value.disabled = op.value === "remove";
  value.addEventListener("input", () => (STATE.dirty = true));

  op.addEventListener("change", () => {
    value.disabled = op.value === "remove";
    if (op.value === "remove") value.value = "";
    STATE.dirty = true;
  });

  const del = document.createElement("button");
  del.type = "button";
  del.className = "danger-btn h-del";
  del.textContent = "✕";
  del.title = "Remove rule";
  del.addEventListener("click", () => {
    row.remove();
    STATE.dirty = true;
  });

  row.appendChild(name);
  row.appendChild(op);
  row.appendChild(value);
  row.appendChild(del);
  return row;
}

function readHeaderRules(kind) {
  const container = $(kind === "req" ? "req-headers" : "res-headers");
  const out = [];
  for (const row of container.querySelectorAll(".header-rule")) {
    const name = row.querySelector(".h-name").value.trim();
    const op = row.querySelector(".h-op").value;
    const value = row.querySelector(".h-value").value;
    if (!name) continue;
    if (op !== "remove" && !value) continue;
    out.push({ name, op, value: op === "remove" ? "" : value });
  }
  return out;
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

// ─────────────────── Downloads / yt-dlp bridge ───────────────────

function bindDownloads(g) {
  $("g-overlay").checked = g.mediaOverlayEnabled !== false;
  $("g-overlay").addEventListener("change", async (e) => {
    await setGlobal({ mediaOverlayEnabled: e.target.checked });
    toast(`Download badges ${e.target.checked ? "on" : "off"} by default`, "ok");
  });

  const y = g.ytdlp || {};
  $("y-outdir").value = y.outputDir || "";
  $("y-quality").value = y.quality || "best";
  $("y-mp4").checked = y.preferMp4 !== false;
  $("y-ytdlp").value = y.ytdlpPath || "";
  $("y-ffmpeg").value = y.ffmpegPath || "";
  $("y-cookies").value = y.cookiesFromBrowser || "";
  $("y-cookies-send").checked = !!y.sendCookies;
  $("y-extra").value = y.extraArgs || "";

  // Debounced, but edits to different fields inside the window are merged so
  // none of them get lost.
  let pendingY = {};
  const flushY = debounce(async () => {
    const patch = pendingY;
    pendingY = {};
    await setGlobal({ ytdlp: patch });
    toast("Saved", "ok");
    // Paths changed → the host's cached lookup is stale; force a re-ping.
    if ("ytdlpPath" in patch || "ffmpegPath" in patch || "outputDir" in patch) checkBridge(true);
  }, 400);
  const pushY = (patch) => {
    pendingY = { ...pendingY, ...patch };
    flushY();
  };

  $("y-outdir").addEventListener("input", (e) => pushY({ outputDir: e.target.value.trim() }));
  $("y-quality").addEventListener("change", (e) => pushY({ quality: e.target.value }));
  $("y-mp4").addEventListener("change", (e) => pushY({ preferMp4: e.target.checked }));
  $("y-ytdlp").addEventListener("input", (e) => pushY({ ytdlpPath: e.target.value.trim() }));
  $("y-ffmpeg").addEventListener("input", (e) => pushY({ ffmpegPath: e.target.value.trim() }));
  $("y-cookies").addEventListener("change", (e) => pushY({ cookiesFromBrowser: e.target.value }));
  $("y-cookies-send").addEventListener("change", (e) => pushY({ sendCookies: e.target.checked }));
  $("y-extra").addEventListener("input", (e) => pushY({ extraArgs: e.target.value }));

  const id = chrome.runtime.id;
  $("ext-id").textContent = id;
  $("install-cmd").textContent = `./native/install.sh ${id}    # Windows: native\\install.cmd ${id}`;
  $("install-oneliner").textContent = helperInstallCommand(id);
  document.querySelectorAll("code[data-copy]").forEach((c) => {
    c.title = "Click to copy";
    c.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(c.textContent);
        toast("Copied", "ok");
      } catch (e) {
        toast(`Copy failed: ${e.message}`, "err");
      }
    });
  });

  $("bridge-recheck").addEventListener("click", () => checkBridge(true));
  $("bridge-setup").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "open-helper-setup" }).catch(() => {});
  });
  $("bridge-update").addEventListener("click", async () => {
    const b = $("bridge-update");
    b.disabled = true;
    b.textContent = "Updating…";
    try {
      const r = await chrome.runtime.sendMessage({ type: "ytdlp-update" });
      if (!r || r.ok === false) throw new Error((r && r.error) || "no response");
      const u = r.result || {};
      toast(u.updated ? `yt-dlp updated to ${u.version}` : u.ok ? `yt-dlp ${u.version} is already the latest` : `Update failed: ${(u.output || "").split("\n").pop()}`, u.ok ? "ok" : "err");
      checkBridge(true);
    } catch (e) {
      toast(`Update failed: ${e.message}`, "err");
    } finally {
      b.disabled = false;
      b.textContent = "Update yt-dlp";
    }
  });
  checkBridge(false);
}

async function checkBridge(force) {
  const dot = $("bridge-dot");
  const text = $("bridge-text");
  dot.className = "bridge-dot";
  text.textContent = "Checking…";
  let res = null;
  try {
    const r = await chrome.runtime.sendMessage({ type: "ytdlp-status", force: !!force });
    if (!r || r.ok === false) throw new Error((r && r.error) || "no response");
    res = r.result;
  } catch (e) {
    res = { available: false, error: String(e.message || e) };
  }
  const setup = $("bridge-setup");
  const update = $("bridge-update");
  if (res.available) {
    dot.className = `bridge-dot ${res.ffmpeg ? "ok" : "warn"}`;
    const yt = res.ytdlp || {};
    const ff = res.ffmpeg;
    text.textContent = `Connected · yt-dlp ${yt.version || ""}` + (ff ? ` · ffmpeg ${ff.version || ""}` : " · ffmpeg NOT found: video+audio can't be merged");
    text.title = [yt.display || yt.path, ff && ff.path, res.helperDir && `Helper folder: ${res.helperDir}`].filter(Boolean).join("\n");
    setup.textContent = "Setup page";
    setup.className = "text-btn";
    update.hidden = false;
  } else {
    const notInstalled = /not installed/i.test(res.error || "");
    dot.className = "bridge-dot err";
    text.textContent = notInstalled ? "Not set up yet" : `Needs a repair: ${res.error || "unknown"}`;
    text.title = res.error || "";
    setup.textContent = notInstalled ? "Set up the Helper" : "Repair the Helper";
    setup.className = "primary-btn";
    update.hidden = true;
  }
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
