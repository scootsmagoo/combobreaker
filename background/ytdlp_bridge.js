// yt-dlp native messaging bridge (service-worker side).
//
// Talks to native/host.js through chrome.runtime.connectNative. Owns the job
// table (chrome.storage.session so the popup can re-read it after the SW
// sleeps) and fans progress out to the popup and to the tab that started the
// job so the on-page badge can show a percentage.
//
// The port is opened lazily and closed after a quiet period so the host
// process doesn't linger and the SW can idle.

import { getGlobal } from "../lib/storage.js";
import { RELOAD_AT_KEY, REOPEN_KEY, helperPermissionState } from "../lib/helper.js";
import { describeDownloadError, shortDownloadError } from "../lib/download_errors.js";

export const HOST_NAME = "com.combobreaker.ytdlp";
const JOBS_KEY = "ytdlp:jobs";
const MAX_JOBS = 40;
const IDLE_CLOSE_MS = 90_000;
// A cold yt-dlp start can take a few seconds; the ping probes yt-dlp and ffmpeg.
const PING_TIMEOUT_MS = 45_000;
const UPDATE_TIMEOUT_MS = 200_000;

let port = null;
let portError = null;
let idleTimer = null;
let pendingPing = null; // { resolve, reject, timer }
let pendingUpdate = null; // { id, resolve, timer }
let statusCache = null; // { at, value }
const jobs = new Map(); // id -> job (in-memory mirror of storage.session)
let jobsLoaded = false;
let persistTimer = null;

// ---------- settings ----------

async function bridgeSettings() {
  const g = await getGlobal();
  const y = g.ytdlp || {};
  return {
    outputDir: y.outputDir || "",
    ytdlpPath: y.ytdlpPath || "",
    ffmpegPath: y.ffmpegPath || "",
    preferMp4: y.preferMp4 !== false,
    extraArgs: y.extraArgs || "",
    cookiesFromBrowser: y.cookiesFromBrowser || "",
    sendCookies: !!y.sendCookies,
  };
}

// ---------- cookies ----------

// Netscape cookie file for everything this browser would send to `url`, so
// yt-dlp can pass YouTube's "sign in to confirm you're not a bot" check the
// same way the tab did. Opt-in (Options › Downloads). No keychain prompts:
// chrome.cookies hands them over already decrypted.
async function cookieFileFor(url) {
  if (!url || !chrome.cookies) return "";
  let list = [];
  try {
    list = await chrome.cookies.getAll({ url });
  } catch {
    return "";
  }
  if (!list.length) return "";
  const lines = ["# Netscape HTTP Cookie File", "# Exported by ComboBreaker for one download; deleted afterwards.", ""];
  for (const c of list) {
    const domain = c.domain || "";
    const sub = domain.startsWith(".") ? "TRUE" : "FALSE";
    const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    lines.push([domain, sub, c.path || "/", c.secure ? "TRUE" : "FALSE", String(expiry), c.name, c.value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

// ---------- port ----------

// ---------- optional permission ----------

// nativeMessaging is an optional permission (asked for on the Helper setup
// page). Chrome records the grant at once, but a service worker that was
// already running keeps a chrome.runtime without connectNative until the
// extension is reloaded. Removing and re-adding the extension (a fresh
// unpacked load, a reinstall from a package) also drops the grant, so an
// already-installed Helper then looks "not connected". permissionState()
// tells the two apart and reloadForPermission() gets the worker unstuck.
export const NEEDS_PERMISSION = "ComboBreaker has not been allowed to talk to the Helper yet.";
export const NEEDS_RELOAD = "Permission granted. ComboBreaker is restarting to finish; this takes a second.";
export const NEEDS_BROWSER_RESTART =
  "Chrome granted the permission but has not activated it. Quit the browser completely and open it again.";

const NM = { permissions: ["nativeMessaging"] };

async function hasNativeMessagingGrant() {
  try {
    return !!(await chrome.permissions.contains(NM));
  } catch {
    // No permissions API at all (very old browser): trust the binding.
    return typeof chrome.runtime.connectNative === "function";
  }
}

export async function permissionState() {
  const granted = await hasNativeMessagingGrant();
  const bound = typeof chrome.runtime.connectNative === "function";
  let lastReloadAt = 0;
  try {
    lastReloadAt = Number((await chrome.storage.local.get(RELOAD_AT_KEY))[RELOAD_AT_KEY]) || 0;
  } catch {}
  const state = helperPermissionState({ granted, bound, lastReloadAt });
  if (state === "ready" && lastReloadAt) {
    // The reload did its job; forget it so a later grant can reload again.
    chrome.storage.local.remove(RELOAD_AT_KEY).catch(() => {});
  }
  return state;
}

let reloadScheduled = false;

// Reload the extension so the worker picks up the freshly granted API. If the
// setup page is open it is reopened in the same place afterwards
// (reopenHelperSetupIfPending in media.js). The response to whichever message
// asked for status goes out first; the reload follows a moment later.
async function reloadForPermission() {
  if (reloadScheduled) return;
  reloadScheduled = true;
  const patch = { [RELOAD_AT_KEY]: Date.now() };
  try {
    const url = chrome.runtime.getURL("viewer/helper_setup.html");
    const open = await chrome.tabs.query({ url });
    if (open.length) patch[REOPEN_KEY] = { windowId: open[0].windowId, index: open[0].index };
  } catch {}
  try {
    await chrome.storage.local.set(patch);
  } catch {}
  setTimeout(() => chrome.runtime.reload(), 400);
}

function dropPort(reason) {
  statusCache = null;
  if (!port) return;
  try {
    port.disconnect();
  } catch {}
  port = null;
  portError = reason || null;
}

if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener((p) => {
    if (!p || !p.permissions || !p.permissions.includes("nativeMessaging")) return;
    // Runs the state machine: reloads if the API is missing, otherwise the next
    // status call simply connects.
    statusCache = null;
    ytdlpStatus(true).catch(() => {});
  });
  chrome.permissions.onRemoved.addListener((p) => {
    if (!p || !p.permissions || !p.permissions.includes("nativeMessaging")) return;
    dropPort("permission removed");
  });
}

function ensurePort() {
  if (port) return port;
  portError = null;
  if (typeof chrome.runtime.connectNative !== "function") {
    portError = NEEDS_PERMISSION;
    return null;
  }
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    port = null;
    portError = String((e && e.message) || e);
    return null;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
    portError = err || "disconnected";
    port = null;
    statusCache = null;
    if (pendingPing) {
      clearTimeout(pendingPing.timer);
      pendingPing.reject(new Error(friendlyPortError(portError)));
      pendingPing = null;
    }
    // Any job still running just lost its process.
    for (const job of jobs.values()) {
      if (isActive(job)) {
        failJob(job.id, `bridge disconnected (${portError})`);
      }
    }
  });
  touchIdle();
  return port;
}

function friendlyPortError(msg) {
  const m = String(msg || "");
  if (/Specified native messaging host not found/i.test(m)) {
    return "Helper not installed.";
  }
  if (/Access to the specified native messaging host is forbidden/i.test(m)) {
    return "Helper is installed for a different copy of ComboBreaker. Run the setup again to re-register it.";
  }
  if (/Native host has exited/i.test(m)) {
    return "Helper quit right after starting. Run the setup again to repair it.";
  }
  if (/Error when communicating/i.test(m)) {
    return "Helper crashed while talking to the extension. Run the setup again to repair it.";
  }
  return m || "unknown error";
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!port) return;
    for (const job of jobs.values()) if (isActive(job)) return touchIdle();
    try {
      port.disconnect();
    } catch {}
    port = null;
  }, IDLE_CLOSE_MS);
}

function post(msg) {
  const p = ensurePort();
  if (!p) throw new Error(friendlyPortError(portError));
  p.postMessage(msg);
  touchIdle();
}

function onHostMessage(msg) {
  touchIdle();
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "pong") {
    if (pendingPing) {
      clearTimeout(pendingPing.timer);
      pendingPing.resolve(msg);
      pendingPing = null;
    }
    return;
  }
  if (msg.type === "updated") {
    if (pendingUpdate && (!msg.id || msg.id === pendingUpdate.id)) {
      clearTimeout(pendingUpdate.timer);
      pendingUpdate.resolve(msg);
      pendingUpdate = null;
    }
    statusCache = null; // version may have changed
    return;
  }
  const id = msg.id != null ? String(msg.id) : null;
  switch (msg.type) {
    case "started":
      if (id) updateJob(id, { status: "downloading", pid: msg.pid, outputDir: msg.outputDir, cmd: msg.cmd, args: msg.args });
      break;
    case "progress":
      if (id) {
        const updating = msg.status === "updating";
        updateJob(id, {
          status: msg.status === "processing" || updating ? "processing" : "downloading",
          percent: msg.percent != null ? msg.percent : msg.status === "processing" ? 100 : undefined,
          downloaded: msg.downloaded,
          total: msg.total,
          speed: msg.speed,
          eta: msg.eta,
          stage: updating ? "Updating yt-dlp" : msg.stage || null,
          title: msg.title || undefined,
        });
      }
      break;
    case "done":
      if (id) updateJob(id, { status: "done", percent: 100, filepath: msg.filepath || null, title: msg.title || undefined, finishedAt: Date.now() });
      break;
    case "cancelled":
      if (id) updateJob(id, { status: "cancelled", finishedAt: Date.now() });
      break;
    case "error":
      if (id) failJob(id, msg.message || "error", { log: msg.log || undefined });
      else console.warn("[ComboBreaker] yt-dlp host error:", msg.message);
      break;
    case "log":
      if (id) {
        const job = jobs.get(id);
        if (job) {
          const log = (job.log || []).concat(msg.lines || []).slice(-40);
          updateJob(id, { log });
        }
      }
      break;
    default:
      break;
  }
}

// ---------- status ----------

export async function ytdlpStatus(force = false) {
  if (!force && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  const perm = await permissionState();
  if (perm !== "ready") {
    // Never cached: these change the moment the user clicks Allow or the
    // extension reloads.
    statusCache = null;
    const value = { available: false, ytdlp: null, ffmpeg: null, permission: perm };
    if (perm === "needs-permission") {
      value.needsPermission = true;
      value.error = NEEDS_PERMISSION;
    } else if (perm === "needs-reload") {
      value.needsReload = true;
      value.error = NEEDS_RELOAD;
      reloadForPermission();
    } else {
      value.needsBrowserRestart = true;
      value.error = NEEDS_BROWSER_RESTART;
    }
    return value;
  }
  const settings = await bridgeSettings();
  let value;
  try {
    const pong = await ping({ ...settings, force: !!force });
    value = {
      available: !!(pong.ytdlp && pong.ytdlp.path),
      hostVersion: pong.version,
      platform: pong.platform,
      node: pong.node,
      helperDir: pong.helperDir || null,
      ytdlp: pong.ytdlp || null,
      ffmpeg: pong.ffmpeg || null,
      outputDir: pong.outputDir || "",
      error: pong.ytdlp ? null : "Helper is installed but yt-dlp is missing. Run the setup again to repair it.",
    };
  } catch (e) {
    value = { available: false, error: String((e && e.message) || e), ytdlp: null, ffmpeg: null };
  }
  value.permission = "ready";
  statusCache = { at: Date.now(), value };
  return value;
}

function ping(settings) {
  return new Promise((resolve, reject) => {
    if (pendingPing) {
      // Coalesce concurrent pings.
      const prev = pendingPing;
      pendingPing = {
        resolve: (v) => {
          prev.resolve(v);
          resolve(v);
        },
        reject: (e) => {
          prev.reject(e);
          reject(e);
        },
        timer: prev.timer,
      };
      return;
    }
    // Always settle through the *current* wrapper so coalesced callers are
    // rejected too.
    const timer = setTimeout(() => {
      const p = pendingPing;
      if (p) {
        pendingPing = null;
        p.reject(new Error("Native host did not answer the ping (timeout)."));
      }
    }, PING_TIMEOUT_MS);
    pendingPing = { resolve, reject, timer };
    try {
      post({ type: "ping", ...settings });
    } catch (e) {
      clearTimeout(timer);
      const p = pendingPing;
      pendingPing = null;
      if (p) p.reject(e);
      else reject(e);
    }
  });
}

// ---------- jobs ----------

function isActive(job) {
  return job && (job.status === "queued" || job.status === "downloading" || job.status === "processing");
}

let jobsLoading = null;
function loadJobs() {
  if (jobsLoaded) return Promise.resolve();
  if (jobsLoading) return jobsLoading;
  jobsLoading = (async () => {
    try {
      const data = await chrome.storage.session.get(JOBS_KEY);
      let dirty = false;
      for (const j of data[JOBS_KEY] || []) {
        // Anything that was "active" when the SW died is gone.
        if (isActive(j)) {
          j.status = "error";
          j.error = "interrupted (service worker restarted)";
          j.finishedAt = Date.now();
          dirty = true;
        }
        if (!jobs.has(j.id)) jobs.set(j.id, j);
      }
      if (dirty) persistJobs();
    } catch {}
    jobsLoaded = true;
  })();
  return jobsLoading;
}

function persistJobs() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    const list = [...jobs.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    if (list.length > MAX_JOBS) {
      for (const j of list.splice(0, list.length - MAX_JOBS)) if (!isActive(j)) jobs.delete(j.id);
    }
    try {
      await chrome.storage.session.set({ [JOBS_KEY]: [...jobs.values()] });
    } catch {}
  }, 300);
}

// Every failure goes through here so the popup, the on-page badge and the
// notification share one explanation (job.errorTitle / job.hint /
// job.hintAction) and the raw yt-dlp text stays in job.error.
function failJob(id, error, extra = {}) {
  const job = jobs.get(id);
  if (!job) return;
  const raw = String(error || "error");
  const d = describeDownloadError(raw, { cookiesSent: !!job.cookiesSent });
  updateJob(id, {
    status: "error",
    error: raw,
    errorShort: shortDownloadError(raw),
    errorKind: d ? d.kind : null,
    errorTitle: d ? d.title : null,
    hint: d ? d.hint : null,
    hintAction: d ? d.action : null,
    finishedAt: Date.now(),
    ...extra,
  });
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  const wasActive = isActive(job);
  const prevStatus = job.status;
  for (const k of Object.keys(patch)) if (patch[k] !== undefined) job[k] = patch[k];
  job.updated = Date.now();
  persistJobs();
  broadcast(job, wasActive, prevStatus !== job.status);
}

let lastBroadcast = new Map(); // id -> ts
function broadcast(job, wasActive, statusChanged) {
  const now = Date.now();
  const terminal = !isActive(job);
  const last = lastBroadcast.get(job.id) || 0;
  // Throttle percent ticks, never state transitions (e.g. -> "processing",
  // which is followed by silence during a long ffmpeg merge).
  if (!terminal && !statusChanged && now - last < 200) return;
  lastBroadcast.set(job.id, now);
  const payload = { type: "cb-ytdlp-job", job: publicJob(job) };
  chrome.runtime.sendMessage(payload).catch(() => {});
  if (job.tabId != null && job.tabId >= 0) {
    chrome.tabs.sendMessage(job.tabId, payload).catch(() => {});
  }
  if (terminal && wasActive) {
    if (job.status === "done") notify(job, "Download finished", job.filepath || job.title || job.url);
    else if (job.status === "error") {
      notify(job, job.errorTitle || "Download failed", job.hint || job.errorShort || job.error || "", job.hintAction);
    }
  }
}

function publicJob(job) {
  const { args, cmd, ...rest } = job;
  void args;
  void cmd;
  return rest;
}

// Notification ids carry the action so the click handler needs no state:
// cb-ytdlp-<jobId>-<action>.
const NOTIFICATION_ACTIONS = {
  "options-downloads": "Open options",
};

function notify(job, title, message, action) {
  // Only when the notifications permission was granted at some point; it's
  // optional so we never nag. Failure is silent.
  try {
    if (!chrome.notifications) return;
    const label = action && NOTIFICATION_ACTIONS[action];
    const opts = {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: `ComboBreaker · ${title}`,
      message: String(message || "").slice(0, 300),
      silent: true,
    };
    if (label) {
      opts.buttons = [{ title: label }];
      opts.requireInteraction = true;
    }
    const p = chrome.notifications.create(`cb-ytdlp-${job.id}-${label ? action : "none"}`, opts);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}

function onNotificationActivated(notificationId) {
  const m = /^cb-ytdlp-[^-]+-(.+)$/.exec(String(notificationId || ""));
  if (!m || m[1] === "none") return;
  if (m[1] === "options-downloads") {
    chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html#downloads") }).catch(() => {});
  }
  try {
    chrome.notifications.clear(notificationId);
  } catch {}
}

// Listeners must be registered at worker start; if the permission arrives
// later they exist after the next worker start, which the bridge's own
// reload usually provides.
if (chrome.notifications && chrome.notifications.onButtonClicked) {
  chrome.notifications.onButtonClicked.addListener((id) => onNotificationActivated(id));
  chrome.notifications.onClicked.addListener((id) => onNotificationActivated(id));
}

export async function ytdlpDownload({ url, quality, title, tabId, itemId, page, referer, thumb, site }) {
  if (!url || !/^https?:/i.test(url)) throw new Error("url must be http(s)");
  await loadJobs();
  const settings = await bridgeSettings();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    id,
    url,
    page: page || url,
    quality: quality || "best",
    title: title || "",
    thumb: thumb || "",
    site: site || "",
    tabId: tabId != null ? tabId : -1,
    itemId: itemId || null,
    status: "queued",
    percent: 0,
    startedAt: Date.now(),
    updated: Date.now(),
  };
  jobs.set(id, job);
  persistJobs();
  broadcast(job, false, true);
  const { sendCookies, ...hostSettings } = settings;
  const cookies = sendCookies ? await cookieFileFor(page || url) : "";
  job.cookiesSent = !!cookies;
  try {
    post({
      type: "download",
      id,
      url,
      quality: job.quality,
      title: job.title,
      referer: referer || page || "",
      cookies,
      ...hostSettings,
    });
  } catch (e) {
    failJob(id, String((e && e.message) || e));
    throw e;
  }
  return publicJob(job);
}

export async function ytdlpCancel(jobId) {
  await loadJobs();
  const job = jobs.get(String(jobId));
  if (!job) return { ok: false };
  if (isActive(job)) {
    try {
      post({ type: "cancel", id: job.id });
    } catch {
      updateJob(job.id, { status: "cancelled", finishedAt: Date.now() });
    }
  }
  return { ok: true };
}

export async function ytdlpReveal(path) {
  if (!path) throw new Error("path required");
  post({ type: "reveal", path });
  return { ok: true };
}

export async function ytdlpJobs() {
  await loadJobs();
  return [...jobs.values()].map(publicJob).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export async function ytdlpClearJobs() {
  await loadJobs();
  for (const [id, j] of jobs) if (!isActive(j)) jobs.delete(id);
  persistJobs();
  return { ok: true };
}

// Ask the host to run `yt-dlp -U`. Resolves { ok, updated, version, output }.
export function ytdlpUpdate() {
  return new Promise((resolve, reject) => {
    if (pendingUpdate) return reject(new Error("an update is already running"));
    const id = `u${Date.now().toString(36)}`;
    const timer = setTimeout(() => {
      if (pendingUpdate && pendingUpdate.id === id) {
        pendingUpdate = null;
        reject(new Error("update timed out"));
      }
    }, UPDATE_TIMEOUT_MS);
    pendingUpdate = { id, resolve, timer };
    bridgeSettings()
      .then((s) => post({ type: "update", id, ytdlpPath: s.ytdlpPath }))
      .catch((e) => {
        clearTimeout(timer);
        pendingUpdate = null;
        reject(e);
      });
  });
}

export function ytdlpCommandFor(url, quality) {
  const q = String(quality || "best").toLowerCase();
  let fmt = "";
  if (q === "audio") fmt = " -x --audio-format mp3";
  else if (/^\d{3,4}$/.test(q)) fmt = ` -f "bv*[height<=${q}]+ba/b[height<=${q}]"`;
  return `yt-dlp${fmt} "${url}"`;
}
