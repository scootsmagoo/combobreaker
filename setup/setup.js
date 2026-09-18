// Video download setup: one status light, one command per OS, one button.
// The command fetches native/setup.ps1 (or setup.sh) from the public repo and
// runs it with this install's extension id; see those scripts for what they do.

import { getGlobal, setGlobal } from "../lib/storage.js";

const RAW = "https://raw.githubusercontent.com/scootsmagoo/combobreaker/main/native";
const ID = chrome.runtime.id;
const UNIX_CMD = `curl -fsSL ${RAW}/setup.sh | bash -s -- ${ID}`;

const OS = {
  windows: {
    // Works when pasted into either PowerShell or cmd.
    cmd: `powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((curl.exe -fsSL ${RAW}/setup.ps1 | Out-String))) -ExtensionId ${ID}"`,
    openTitle: "Open Terminal",
    openHint: "Right-click the Start button and choose Terminal (on Windows 10: Windows PowerShell).",
    pasteHint: "Paste with Ctrl+V or a right-click. It takes a minute or two and doesn't need administrator rights.",
    update: "winget upgrade yt-dlp.yt-dlp",
    cookies:
      "On Windows, Chrome, Edge and Brave lock their sign-in data, so this usually only works with Firefox: sign into YouTube in Firefox once, then choose Firefox here.",
  },
  mac: {
    cmd: UNIX_CMD,
    openTitle: "Open Terminal",
    openHint: "Press ⌘ + Space, type Terminal, press Return.",
    pasteHint:
      "Paste with ⌘ + V. It uses Homebrew; if you don't have Homebrew yet, the command tells you the one line that installs it, then you run this command again.",
    update: "brew upgrade yt-dlp",
    cookies:
      "The first time, macOS asks to let yt-dlp read the browser's saved sign-in (a Keychain prompt) — choose Always Allow. For Safari, Terminal also needs Full Disk Access in System Settings → Privacy & Security.",
  },
  linux: {
    cmd: UNIX_CMD,
    openTitle: "Open a terminal",
    openHint: "Usually Ctrl + Alt + T.",
    pasteHint: "Paste with Ctrl + Shift + V. It may ask for your password to install packages with apt, dnf or pacman.",
    update: "yt-dlp -U   (or update it with your package manager)",
    cookies: "Choose the browser where you're signed into YouTube. Snap and Flatpak browsers keep their data where yt-dlp may not find it.",
  },
};

const $ = (id) => document.getElementById(id);
let pollTimer = null;
let os = detectOs();

function detectOs() {
  const p = `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""} ${navigator.userAgent}`;
  if (/win/i.test(p)) return "windows";
  if (/mac/i.test(p)) return "mac";
  return "linux";
}

function renderOs() {
  const o = OS[os];
  document.querySelectorAll(".os-tab").forEach((t) => {
    const on = t.dataset.os === os;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  $("cmd").textContent = o.cmd;
  $("open-title").textContent = o.openTitle;
  $("open-hint").textContent = o.openHint;
  $("paste-hint").textContent = o.pasteHint;
  $("update-cmd").textContent = o.update;
  $("cookies-note").textContent = o.cookies;
}

async function check(force) {
  let res;
  try {
    const r = await chrome.runtime.sendMessage({ type: "ytdlp-status", force: !!force });
    res = r && r.ok ? r.result : { available: false, error: (r && r.error) || "no response" };
  } catch (e) {
    res = { available: false, error: String(e.message || e) };
  }
  render(res);
  return res;
}

function render(res) {
  const status = $("status");
  const ready = !!(res.available && res.ytdlp);
  if (ready && res.ffmpeg) {
    status.dataset.state = "ok";
    $("status-text").textContent = "Ready";
  } else if (ready) {
    status.dataset.state = "partial";
    $("status-text").textContent = "Almost: ffmpeg is missing, so HD video and audio can't be joined. Run the command again.";
  } else if (res.hostVersion) {
    status.dataset.state = "partial";
    $("status-text").textContent = "Helper found, but yt-dlp is missing. Run the command again.";
  } else {
    status.dataset.state = "missing";
    $("status-text").textContent = "Not set up yet";
  }

  const done = ready && !!res.ffmpeg;
  $("done").hidden = !done;
  $("steps").hidden = done;
  if (done) {
    $("done-detail").textContent = `yt-dlp ${res.ytdlp.version || ""} · ffmpeg ${res.ffmpeg.version || ""} · saving to ${res.outputDir || "your Downloads folder"}`;
    clearInterval(pollTimer);
    pollTimer = null;
  } else if (!pollTimer) {
    // Notice by ourselves when the install finishes.
    pollTimer = setInterval(() => check(true), 4000);
  }
}

async function copyFrom(codeEl, btn) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(codeEl.textContent);
    btn.textContent = "Copied ✓";
  } catch {
    // Clipboard blocked: select it so the keyboard shortcut works.
    getSelection().selectAllChildren(codeEl);
    btn.textContent = os === "mac" ? "Press ⌘C" : "Press Ctrl+C";
  }
  setTimeout(() => (btn.textContent = label), 2000);
}

$("copy").addEventListener("click", (e) => copyFrom($("cmd"), e.currentTarget));
document.querySelectorAll("[data-copy-from]").forEach((btn) => {
  btn.addEventListener("click", () => copyFrom($(btn.dataset.copyFrom), btn));
});

$("recheck").addEventListener("click", async () => {
  $("status").dataset.state = "checking";
  $("status-text").textContent = "Checking…";
  await check(true);
});

document.querySelectorAll(".os-tab").forEach((t) => {
  t.addEventListener("click", () => {
    os = t.dataset.os;
    renderOs();
  });
});

// Same setting as Options → Downloads → Advanced → "Cookies from browser".
getGlobal().then((g) => {
  $("cookies").value = (g.ytdlp && g.ytdlp.cookiesFromBrowser) || "";
});
$("cookies").addEventListener("change", async (e) => {
  await setGlobal({ ytdlp: { cookiesFromBrowser: e.target.value } });
  $("cookies-saved").hidden = false;
  setTimeout(() => ($("cookies-saved").hidden = true), 1500);
});

renderOs();
check(true);
