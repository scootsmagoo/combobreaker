// Setup page for the ComboBreaker Helper (opened from the badge, the popup
// and the options page). Shows the one step the user's OS needs, then polls
// the service worker until the helper answers.

import { helperInstallCommand, helperFolderFor, helperUninstallFor } from "../lib/helper.js";

const $ = (id) => document.getElementById(id);
const POLL_MS = 4000;
let os = "mac";
let pollTimer = null;
let connected = false;

async function send(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (!r || r.ok === false) throw new Error((r && r.error) || "no response");
  return r.result;
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied — now paste it into Terminal");
  } catch {
    // Fallback: select the code so Cmd/Ctrl+C works.
    const range = document.createRange();
    range.selectNodeContents($("cmd"));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast("Press ⌘ C / Ctrl C to copy");
  }
}

function setStatus(kind, title, detail) {
  const el = $("status");
  el.className = `status ${kind}`;
  $("status-title").textContent = title;
  $("status-detail").textContent = detail || "";
}

async function check(force) {
  let s;
  try {
    s = await send({ type: "ytdlp-status", force: !!force });
  } catch (e) {
    // "Extension context invalidated" = the worker is reloading and this page
    // is about to be closed and reopened; say so instead of flashing an error.
    if (/context invalidated|message port closed|receiving end/i.test(String(e.message || e))) {
      s = { available: false, needsReload: true };
    } else {
      s = { available: false, error: String(e.message || e) };
    }
  }
  if (s.available) {
    connected = true;
    stopPolling();
    const parts = [`yt-dlp ${s.ytdlp && s.ytdlp.version ? s.ytdlp.version : ""}`.trim()];
    parts.push(s.ffmpeg ? `ffmpeg ${s.ffmpeg.version || ""}`.trim() : "ffmpeg missing");
    setStatus("ok", "Helper connected", parts.join(" · "));
    $("allow").hidden = true;
    $("steps-posix").hidden = true;
    $("steps-win").hidden = true;
    $("done").hidden = false;
    if (s.outputDir) $("outdir").textContent = s.outputDir;
    document.title = "Helper connected · ComboBreaker";
    return;
  }
  connected = false;
  $("allow").hidden = !s.needsPermission;
  $("restart").hidden = !s.needsBrowserRestart;
  if (s.needsPermission) {
    // Only the Allow step: whether the Helper still needs installing is not
    // knowable until the extension may talk to it, and showing the Terminal
    // steps here sends people back to a command that cannot help.
    setStatus("waiting", "One permission first", "Click Allow below. The install steps follow if they are still needed.");
    hideSteps();
    return;
  }
  if (s.needsReload) {
    // The service worker reloads the extension in a moment; Chrome closes this
    // page and the worker reopens it in the same place.
    setStatus("waiting", "Permission granted, restarting ComboBreaker…", "This page closes and comes back by itself in a second.");
    hideSteps();
    return;
  }
  if (s.needsBrowserRestart) {
    setStatus("err", "One more step: restart the browser", s.error || "");
    hideSteps();
    return;
  }
  const err = s.error || "not installed";
  const installedButBroken = !/not installed/i.test(err);
  setStatus(installedButBroken ? "err" : "waiting",
    installedButBroken ? "Helper needs a repair" : "Waiting for the Helper…",
    installedButBroken ? `${err} Running the setup again fixes this.` : "Follow the steps below; this updates by itself.");
  showSteps();
}

function showSteps() {
  if (connected) return;
  $("steps-posix").hidden = os === "win";
  $("steps-win").hidden = os !== "win";
  $("done").hidden = true;
}
function hideSteps() {
  $("steps-posix").hidden = true;
  $("steps-win").hidden = true;
  $("done").hidden = true;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") check(true);
  }, POLL_MS);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// nativeMessaging is optional, so it has to be asked for from a click.
function bindAllow() {
  $("allow-btn").addEventListener("click", async () => {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
    } catch (e) {
      setStatus("err", "Chrome refused the request", String(e.message || e));
      return;
    }
    if (!granted) return setStatus("waiting", "Not allowed", "Without it ComboBreaker cannot reach the Helper. Click Allow to try again.");
    // The worker usually reloads the extension now (Chrome does not hand a
    // running worker the new API). If this page is still here after that, the
    // status call below reports the real state.
    setStatus("waiting", "Permission granted, finishing…", "ComboBreaker may restart for a second; this page comes back by itself.");
    check(true);
  });
}

async function init() {
  bindAllow();
  const id = chrome.runtime.id;
  try {
    const info = await chrome.runtime.getPlatformInfo();
    os = info.os === "win" ? "win" : info.os === "mac" ? "mac" : "linux";
  } catch {}

  const cmd = helperInstallCommand(id);
  $("cmd").textContent = cmd;
  $("copy").addEventListener("click", () => copy(cmd));
  $("cmd").addEventListener("click", () => copy(cmd));
  $("terminal-hint").innerHTML =
    os === "mac"
      ? "Press <kbd>⌘</kbd> <kbd>Space</kbd>, type <strong>Terminal</strong>, press Return. Paste with <kbd>⌘</kbd> <kbd>V</kbd>, then press Return and wait for “Done”."
      : "Open a terminal window, paste with <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>V</kbd>, press Enter and wait for “Done”.";

  $("download-win").addEventListener("click", async () => {
    const b = $("download-win");
    b.disabled = true;
    try {
      const r = await send({ type: "helper-installer-download" });
      toast(`Saved “${r.filename}” to your Downloads`);
    } catch (e) {
      toast(`Download failed: ${e.message}`);
    } finally {
      setTimeout(() => (b.disabled = false), 1500);
    }
  });

  $("recheck").addEventListener("click", () => {
    setStatus("waiting", "Checking…", "");
    check(true);
  });
  $("open-options").addEventListener("click", (e) => {
    e.preventDefault();
    send({ type: "open-options", section: "downloads" }).catch(() => {});
  });

  $("quit-keys").textContent = os === "mac" ? "⌘ Q" : "close every window";
  $("folder").textContent = helperFolderFor(os);
  $("uninstall").textContent = helperUninstallFor(os);
  $("ext-id").textContent = id;
  $("ext-id-2").textContent = id;

  await check(true);
  if (!connected) startPolling();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !connected) check(true);
  });
}

init();
