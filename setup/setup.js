// Video download setup: one status light, one command, one button.
// The command fetches native/setup.ps1 (or setup.sh) from the public repo and
// runs it with this install's extension id; see those scripts for what they do.

const RAW = "https://raw.githubusercontent.com/scootsmagoo/combobreaker/main/native";
const ID = chrome.runtime.id;

const COMMANDS = {
  // Works when pasted into either PowerShell or cmd.
  windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((curl.exe -fsSL ${RAW}/setup.ps1 | Out-String))) -ExtensionId ${ID}"`,
  unix: `curl -fsSL ${RAW}/setup.sh | bash -s -- ${ID}`,
};
const PASTE = {
  windows: {
    title: "Paste it into Terminal and press Enter",
    hint: "Right-click the Start button → Terminal (or PowerShell), paste, Enter. Takes a minute or two.",
  },
  unix: {
    title: "Paste it into Terminal and press Enter",
    hint: "macOS: open Terminal from Spotlight. It may ask for your password to install packages.",
  },
};

const $ = (id) => document.getElementById(id);
let os = /Win/i.test(navigator.platform || navigator.userAgent) ? "windows" : "unix";
let pollTimer = null;

function renderOs() {
  $("cmd").textContent = COMMANDS[os];
  $("paste-title").textContent = PASTE[os].title;
  $("paste-hint").textContent = PASTE[os].hint;
  $("os-label").textContent = os === "windows" ? "Showing the Windows command. " : "Showing the macOS / Linux command. ";
  $("os-toggle").textContent = os === "windows" ? "On macOS or Linux?" : "On Windows?";
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
    $("status-text").textContent = "Almost: ffmpeg is missing, so YouTube video and audio can't be joined. Run the command again.";
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

$("copy").addEventListener("click", async () => {
  const btn = $("copy");
  try {
    await navigator.clipboard.writeText(COMMANDS[os]);
    btn.textContent = "Copied ✓";
  } catch {
    // Clipboard blocked: select it so Ctrl+C works.
    getSelection().selectAllChildren($("cmd"));
    btn.textContent = "Press Ctrl+C";
  }
  setTimeout(() => (btn.textContent = "Copy"), 2000);
});

$("recheck").addEventListener("click", async () => {
  $("status").dataset.state = "checking";
  $("status-text").textContent = "Checking…";
  await check(true);
});

$("os-toggle").addEventListener("click", () => {
  os = os === "windows" ? "unix" : "windows";
  renderOs();
});

renderOs();
check(true);
