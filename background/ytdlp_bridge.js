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

export const HOST_NAME = "com.combobreaker.ytdlp";
const JOBS_KEY = "ytdlp:jobs";
const MAX_JOBS = 40;
const IDLE_CLOSE_MS = 90_000;
const PING_TIMEOUT_MS = 12_000;

let port = null;
let portError = null;
let idleTimer = null;
let pendingPing = null; // { resolve, reject, timer }
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
  };
}

// ---------- port ----------

function ensurePort() {
  if (port) return port;
  portError = null;
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
        updateJob(job.id, { status: "error", error: `bridge disconnected (${portError})` });
      }
    }
  });
  touchIdle();
  return port;
}

function friendlyPortError(msg) {
  const m = String(msg || "");
  if (/Specified native messaging host not found/i.test(m)) {
    return "Native host not registered. Run native/install.ps1 (see ComboBreaker options › Downloads).";
  }
  if (/Access to the specified native messaging host is forbidden/i.test(m)) {
    return "Native host is registered for a different extension ID. Re-run native/install.ps1 with this extension's ID.";
  }
  if (/Native host has exited/i.test(m)) {
    return "Native host exited immediately. Is Node.js on PATH? Check the wrapper .bat in %LOCALAPPDATA%\\ComboBreaker\\native.";
  }
  if (/Error when communicating/i.test(m)) {
    return "Native host crashed or wrote something that wasn't a framed message.";
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
  const id = msg.id != null ? String(msg.id) : null;
  switch (msg.type) {
    case "started":
      if (id) updateJob(id, { status: "downloading", pid: msg.pid, outputDir: msg.outputDir, cmd: msg.cmd, args: msg.args });
      break;
    case "progress":
      if (id) {
        updateJob(id, {
          status: msg.status === "processing" ? "processing" : msg.status === "finished" ? "downloading" : "downloading",
          percent: msg.percent != null ? msg.percent : msg.status === "processing" ? 100 : undefined,
          downloaded: msg.downloaded,
          total: msg.total,
          speed: msg.speed,
          eta: msg.eta,
          stage: msg.stage || null,
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
      if (id) updateJob(id, { status: "error", error: msg.message || "error", log: msg.log || undefined, finishedAt: Date.now() });
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
  const settings = await bridgeSettings();
  let value;
  try {
    const pong = await ping({ ...settings, force: !!force });
    value = {
      available: !!(pong.ytdlp && pong.ytdlp.path),
      hostVersion: pong.version,
      platform: pong.platform,
      node: pong.node,
      ytdlp: pong.ytdlp || null,
      ffmpeg: pong.ffmpeg || null,
      outputDir: pong.outputDir || "",
      error: pong.ytdlp ? null : "Host connected but yt-dlp was not found. Install it or set its path in options.",
    };
  } catch (e) {
    value = { available: false, error: String((e && e.message) || e), ytdlp: null, ffmpeg: null };
  }
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
    else if (job.status === "error") notify(job, "Download failed", job.error || "");
  }
}

function publicJob(job) {
  const { args, cmd, ...rest } = job;
  void args;
  void cmd;
  return rest;
}

function notify(job, title, message) {
  // Only when the notifications permission was granted at some point; it's
  // optional so we never nag. Failure is silent.
  try {
    if (!chrome.notifications) return;
    const p = chrome.notifications.create(`cb-ytdlp-${job.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: `ComboBreaker · ${title}`,
      message: String(message || "").slice(0, 200),
      silent: true,
    });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
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
  try {
    post({
      type: "download",
      id,
      url,
      quality: job.quality,
      title: job.title,
      referer: referer || page || "",
      ...settings,
    });
  } catch (e) {
    updateJob(id, { status: "error", error: String((e && e.message) || e), finishedAt: Date.now() });
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

export function ytdlpCommandFor(url, quality) {
  const q = String(quality || "best").toLowerCase();
  let fmt = "";
  if (q === "audio") fmt = " -x --audio-format mp3";
  else if (/^\d{3,4}$/.test(q)) fmt = ` -f "bv*[height<=${q}]+ba/b[height<=${q}]"`;
  return `yt-dlp${fmt} "${url}"`;
}
