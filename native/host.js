#!/usr/bin/env node
// ComboBreaker native messaging host.
//
// Chrome launches this process (via the wrapper that install.ps1 / install.sh
// writes) when the extension calls chrome.runtime.connectNative(). It bridges
// the extension to a locally installed yt-dlp (+ ffmpeg) so YouTube, DASH and
// split-audio HLS can be downloaded with one click.
//
// Wire protocol (both directions): 4-byte little-endian length + UTF-8 JSON.
//
// Messages from the extension:
//   { type: "ping" }
//     -> { type: "pong", version, platform, ytdlp: {path, version}|null,
//          ffmpeg: {path, version}|null, outputDir }
//   { type: "download", id, url, quality, outputDir?, ytdlpPath?, ffmpegPath?,
//     preferMp4?, extraArgs?, cookiesFromBrowser?, referer? }
//     -> { type: "started", id, ... }
//        { type: "progress", id, status, percent, downloaded, total, speed, eta }
//        ... then { type: "done", id, filepath } | { type: "error", id, message }
//   { type: "cancel", id }            -> { type: "cancelled", id }
//   { type: "reveal", path }          -> { type: "ok" }
//   { type: "log-tail", id }          -> { type: "log", id, lines }
//
// No network calls of its own; it only spawns yt-dlp.

"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOST_VERSION = "1.0.0";
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// ---------- framing ----------

let inbuf = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  for (;;) {
    if (inbuf.length < 4) return;
    const len = inbuf.readUInt32LE(0);
    if (inbuf.length < 4 + len) return;
    const body = inbuf.subarray(4, 4 + len).toString("utf8");
    inbuf = inbuf.subarray(4 + len);
    let msg = null;
    try {
      msg = JSON.parse(body);
    } catch (e) {
      send({ type: "error", message: `bad json: ${e.message}` });
      continue;
    }
    handle(msg).catch((e) => {
      send({ type: "error", id: msg && msg.id, message: String((e && e.message) || e) });
    });
  }
});

process.stdin.on("end", () => shutdown());
process.stdin.on("close", () => shutdown());

function send(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  // Chrome caps a single message at 1 MB.
  if (json.length > 1000000) {
    const trimmed = Buffer.from(
      JSON.stringify({ type: obj.type, id: obj.id, message: "message too large" }),
      "utf8"
    );
    return writeFrame(trimmed);
  }
  writeFrame(json);
}

function writeFrame(json) {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([head, json]));
}

// ---------- state ----------

const jobs = new Map(); // id -> { child, log: string[], done: boolean }

function shutdown() {
  for (const [, job] of jobs) killJob(job);
  process.exit(0);
}

// ---------- tool discovery ----------

const toolCache = new Map(); // key -> { path, version } | null

function whichAll(name) {
  const out = [];
  const cmd = IS_WIN ? "where" : "which";
  const args = IS_WIN ? [name] : ["-a", name];
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.status === 0 && r.stdout) {
      for (const line of r.stdout.split(/\r?\n/)) {
        const p = line.trim();
        if (p && fs.existsSync(p)) out.push(p);
      }
    }
  } catch {}
  return out;
}

// yt-dlp versions look like 2025.11.12 (optionally with a suffix).
function ytdlpSupportsJsRuntimes(version) {
  const m = /^(\d{4})\.(\d{1,2})/.exec(String(version || ""));
  if (!m) return false;
  return Number(m[1]) * 100 + Number(m[2]) >= 202511;
}

function candidatePaths(name) {
  const home = os.homedir();
  const exe = IS_WIN ? `${name}.exe` : name;
  // Next to this script first: setup.ps1 / setup.sh may drop tools here.
  const list = [path.join(__dirname, exe)];
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    list.push(path.join(local, "Microsoft", "WinGet", "Links", exe));
    list.push(path.join(home, "scoop", "shims", exe));
    list.push(path.join("C:\\", "ProgramData", "chocolatey", "bin", exe));
    list.push(path.join(local, "Programs", name, exe));
    list.push(path.join("C:\\", "Program Files", name, exe));
    list.push(path.join("C:\\", "Program Files", name, "bin", exe));
    list.push(path.join("C:\\", name, "bin", exe));
    list.push(path.join("C:\\", name, exe));
    // pip --user installs
    const pyRoot = path.join(local, "Programs", "Python");
    try {
      for (const d of fs.readdirSync(pyRoot)) {
        list.push(path.join(pyRoot, d, "Scripts", exe));
      }
    } catch {}
    try {
      const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      const pyUser = path.join(roaming, "Python");
      for (const d of fs.readdirSync(pyUser)) {
        list.push(path.join(pyUser, d, "Scripts", exe));
      }
    } catch {}
  } else {
    list.push(path.join(home, ".local", "bin", exe));
    list.push("/opt/homebrew/bin/" + exe);
    list.push("/usr/local/bin/" + exe);
    list.push("/usr/bin/" + exe);
    list.push(path.join(home, "bin", exe));
  }
  return list;
}

function findTool(name, override) {
  const key = `${name}|${override || ""}`;
  if (toolCache.has(key)) return toolCache.get(key);
  let found = null;
  const versionArgs = name === "ffmpeg" ? ["-version"] : ["--version"];
  const tryPath = (p) => {
    if (!p) return null;
    const v = readVersion(p, versionArgs);
    return v == null ? null : { path: p, version: v };
  };

  if (override) {
    const p = override.trim();
    if (p) {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        found = tryPath(path.join(p, IS_WIN ? `${name}.exe` : name));
      } else {
        found = tryPath(p);
      }
    }
  }
  if (!found) {
    for (const p of whichAll(name)) {
      found = tryPath(p);
      if (found) break;
    }
  }
  if (!found) {
    for (const p of candidatePaths(name)) {
      if (!fs.existsSync(p)) continue;
      found = tryPath(p);
      if (found) break;
    }
  }
  if (!found && name === "yt-dlp") {
    // pip-installed module without a console script on PATH.
    for (const py of ["python", "python3", "py"]) {
      const r = safeSpawnSync(py, ["-m", "yt_dlp", "--version"]);
      if (r && r.status === 0 && r.stdout.trim()) {
        found = { path: `${py} -m yt_dlp`, version: r.stdout.trim().split(/\r?\n/)[0], viaPython: py };
        break;
      }
    }
  }
  // Only cache hits: the user may install yt-dlp while this host process is
  // still alive and then hit "re-check" in the extension.
  if (found) toolCache.set(key, found);
  return found;
}

function safeSpawnSync(cmd, args) {
  try {
    return spawnSync(cmd, args, { encoding: "utf8", timeout: 15000, windowsHide: true });
  } catch {
    return null;
  }
}

function readVersion(p, args) {
  const r = safeSpawnSync(p, args);
  if (!r || r.status !== 0) return null;
  const first = String(r.stdout || r.stderr || "").split(/\r?\n/)[0].trim();
  if (!first) return "";
  const m = /(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?|\d+\.\d+(?:\.\d+)?)/.exec(first);
  return m ? m[1] : first.slice(0, 40);
}

function defaultOutputDir() {
  return path.join(os.homedir(), "Downloads", "combobreaker");
}

// ---------- handlers ----------

async function handle(msg) {
  switch (msg && msg.type) {
    case "ping":
      return handlePing(msg);
    case "download":
      return handleDownload(msg);
    case "cancel":
      return handleCancel(msg);
    case "reveal":
      return handleReveal(msg);
    case "log-tail": {
      const job = jobs.get(String(msg.id));
      return send({ type: "log", id: msg.id, lines: job ? job.log.slice(-60) : [] });
    }
    default:
      return send({ type: "error", id: msg && msg.id, message: `unknown type ${msg && msg.type}` });
  }
}

function handlePing(msg) {
  if (msg.force) toolCache.clear();
  const ytdlp = findTool("yt-dlp", msg.ytdlpPath);
  const ffmpeg = findTool("ffmpeg", msg.ffmpegPath);
  send({
    type: "pong",
    version: HOST_VERSION,
    platform: process.platform,
    node: process.version,
    ytdlp,
    ffmpeg,
    outputDir: (msg.outputDir && msg.outputDir.trim()) || defaultOutputDir(),
  });
}

function qualityToArgs(quality, hasFfmpeg) {
  // Returns an array of yt-dlp args for the requested preset.
  const q = String(quality || "best").toLowerCase();
  if (q === "audio") {
    return hasFfmpeg
      ? ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"]
      : ["-f", "ba/b"];
  }
  const m = /^(\d{3,4})p?$/.exec(q);
  if (m) {
    const h = m[1];
    return hasFfmpeg
      ? ["-f", `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`]
      : ["-f", `b[height<=${h}]/b`];
  }
  // "best": yt-dlp's own default already picks bv*+ba when ffmpeg exists and
  // falls back to the best single file otherwise.
  return [];
}

function handleDownload(msg) {
  const id = String(msg.id || Date.now());
  if (!msg.url || !/^https?:/i.test(msg.url)) {
    return send({ type: "error", id, message: "url must be http(s)" });
  }
  const ytdlp = findTool("yt-dlp", msg.ytdlpPath);
  if (!ytdlp) {
    return send({
      type: "error",
      id,
      message:
        "yt-dlp not found. Install it (winget install yt-dlp.yt-dlp) or set its path in ComboBreaker options.",
    });
  }
  const ffmpeg = findTool("ffmpeg", msg.ffmpegPath);
  const outDir = (msg.outputDir && msg.outputDir.trim()) || defaultOutputDir();
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    return send({ type: "error", id, message: `cannot create output dir: ${e.message}` });
  }

  const template = msg.filenameTemplate || "%(title).120B [%(id)s].%(ext)s";
  const args = [
    "--no-playlist",
    "--newline",
    "--no-colors",
    "--no-quiet",
    "--no-simulate",
    "--progress",
    "--progress-template",
    "download:CBP|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.title)s",
    "--print",
    "after_move:CBF|%(filepath)s",
    "-o",
    path.join(outDir, template),
    "--windows-filenames",
    "--no-mtime",
  ];
  if (ffmpeg) {
    args.push("--ffmpeg-location", ffmpeg.path);
    if (msg.preferMp4 !== false && String(msg.quality || "best").toLowerCase() !== "audio") {
      args.push("-S", "res,ext:mp4:m4a", "--merge-output-format", "mp4");
    }
  }
  args.push(...qualityToArgs(msg.quality, !!ffmpeg));
  if (msg.referer) args.push("--referer", String(msg.referer));
  if (msg.cookiesFromBrowser) args.push("--cookies-from-browser", String(msg.cookiesFromBrowser));
  // YouTube needs an external JavaScript runtime since yt-dlp 2025.11. yt-dlp
  // only looks for Deno by default; we are already running under Node, so
  // offer that. Older yt-dlp builds don't know the flag, hence the version gate.
  const extra = Array.isArray(msg.extraArgs) ? msg.extraArgs.join(" ") : String(msg.extraArgs || "");
  if (ytdlpSupportsJsRuntimes(ytdlp.version) && !extra.includes("--js-runtimes")) {
    args.push("--js-runtimes", `node:${process.execPath}`);
  }
  if (Array.isArray(msg.extraArgs)) {
    for (const a of msg.extraArgs) if (typeof a === "string" && a) args.push(a);
  } else if (typeof msg.extraArgs === "string" && msg.extraArgs.trim()) {
    args.push(...splitArgs(msg.extraArgs));
  }
  args.push("--", msg.url);

  let cmd = ytdlp.path;
  let finalArgs = args;
  if (ytdlp.viaPython) {
    cmd = ytdlp.viaPython;
    finalArgs = ["-m", "yt_dlp", ...args];
  }

  const job = { child: null, log: [], done: false, filepath: null, title: msg.title || "", cancelled: false };
  jobs.set(id, job);
  let child;
  try {
    child = spawn(cmd, finalArgs, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    jobs.delete(id);
    return send({ type: "error", id, message: `spawn failed: ${e.message}` });
  }
  job.child = child;
  send({ type: "started", id, pid: child.pid, cmd, args: finalArgs, outputDir: outDir });

  let lastProgressAt = 0;
  const onLine = (line) => {
    if (!line) return;
    job.log.push(line);
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400);

    if (line.startsWith("CBP|")) {
      const parts = line.split("|");
      const status = parts[1] || "downloading";
      const downloaded = num(parts[2]);
      const total = num(parts[3]) || num(parts[4]);
      const speed = num(parts[5]);
      const eta = num(parts[6]);
      const title = parts.slice(7).join("|");
      if (title && title !== "NA" && !job.title) job.title = title;
      const percent = total ? Math.min(100, (downloaded / total) * 100) : null;
      const now = Date.now();
      if (status === "finished" || now - lastProgressAt > 150) {
        lastProgressAt = now;
        send({ type: "progress", id, status, percent, downloaded, total, speed, eta, title: job.title });
      }
      return;
    }
    if (line.startsWith("CBF|")) {
      job.filepath = line.slice(4).trim();
      return;
    }
    const m = /^\[(Merger|ExtractAudio|VideoConvertor|VideoRemuxer|Fixup\w+|EmbedThumbnail|Metadata)\]/.exec(line);
    if (m) {
      send({ type: "progress", id, status: "processing", stage: m[1], percent: 100, title: job.title });
      return;
    }
    if (/^ERROR:/.test(line)) {
      send({ type: "log", id, lines: [line] });
    }
  };

  lineReader(child.stdout, onLine);
  lineReader(child.stderr, onLine);

  child.on("error", (e) => {
    if (job.done) return;
    job.done = true;
    jobs.delete(id);
    send({ type: "error", id, message: `yt-dlp failed to start: ${e.message}` });
  });
  child.on("close", (code) => {
    if (job.done) return;
    job.done = true;
    jobs.delete(id);
    if (job.cancelled) {
      send({ type: "cancelled", id });
      return;
    }
    if (code === 0) {
      send({ type: "done", id, filepath: job.filepath, title: job.title, outputDir: outDir });
    } else {
      const errLine = [...job.log].reverse().find((l) => /^ERROR/.test(l)) || job.log.slice(-1)[0] || "";
      send({
        type: "error",
        id,
        message: `yt-dlp exited with code ${code}. ${errLine}`.trim(),
        log: job.log.slice(-40),
      });
    }
  });
}

function handleCancel(msg) {
  const job = jobs.get(String(msg.id));
  if (!job) return send({ type: "cancelled", id: msg.id, note: "no such job" });
  job.cancelled = true;
  killJob(job);
}

function killJob(job) {
  if (!job || !job.child || job.done) return;
  const pid = job.child.pid;
  try {
    if (IS_WIN) {
      // Kill the whole tree so a spawned ffmpeg doesn't outlive yt-dlp.
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 });
    } else {
      job.child.kill("SIGTERM");
    }
  } catch {}
}

function handleReveal(msg) {
  const p = msg.path;
  if (!p || typeof p !== "string") return send({ type: "error", message: "path required" });
  const exists = fs.existsSync(p);
  const isDir = exists && fs.statSync(p).isDirectory();
  const dir = isDir ? p : path.dirname(p);
  try {
    if (IS_WIN) {
      // explorer wants /select,"path" as one argument; hand it over verbatim so
      // Node doesn't re-quote the whole thing when the path has spaces.
      const args = exists && !isDir ? [`/select,"${p}"`] : [`"${dir}"`];
      spawn("explorer.exe", args, { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
    } else if (IS_MAC) {
      spawn("open", exists && !isDir ? ["-R", p] : [dir], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [dir], { detached: true, stdio: "ignore" }).unref();
    }
    send({ type: "ok", path: p });
  } catch (e) {
    send({ type: "error", message: `reveal failed: ${e.message}` });
  }
}

// ---------- utils ----------

function lineReader(stream, onLine) {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    rest += chunk;
    // yt-dlp uses \r for in-place progress unless --newline; handle both.
    const parts = rest.split(/\r\n|\n|\r/);
    rest = parts.pop();
    for (const p of parts) onLine(p.trim());
  });
  stream.on("end", () => {
    if (rest.trim()) onLine(rest.trim());
    rest = "";
  });
}

function num(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t || t === "NA" || t === "None") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function splitArgs(s) {
  // Minimal shell-ish splitter: handles double/single quotes.
  const out = [];
  let cur = "";
  let q = null;
  for (const ch of String(s)) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}
