// Smoke test for the ComboBreaker Helper (native/host.js + bundled tools).
//
// Answers "is the helper broken?" in one command, without a browser:
//   1. finds the installed helper (or --dir <folder>), starts it the way the
//      browser would (via run-host.sh / run-host.cmd), sends a ping and
//      prints the yt-dlp / ffmpeg versions it reports;
//   2. optionally downloads a known short public video into a temp folder
//      and reports the outcome and timing (--download, or --url <url>).
//
//   node scripts/smoke_helper.js                 # ping only
//   node scripts/smoke_helper.js --download      # ping + 480p download of a 19 s clip
//   node scripts/smoke_helper.js --url https://... --quality 720 --keep
//   node scripts/smoke_helper.js --dir "/path/to/helper"
//
// Exit code 0 when everything it tried worked, 1 otherwise. A "sign in to
// confirm you're not a bot" error means YouTube's bot check for this network,
// not a broken helper; the extension's "Use my browser's cookies" setting is
// the fix for that.
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const IS_WIN = process.platform === "win32";
const DEFAULT_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"; // "Me at the zoo", 19 s
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

function defaultHelperDir() {
  const home = os.homedir();
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ComboBreaker", "helper");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "ComboBreaker", "helper");
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "combobreaker", "helper");
}

const dir = opt("--dir", defaultHelperDir());
const wrapper = path.join(dir, IS_WIN ? "run-host.cmd" : "run-host.sh");
if (!fs.existsSync(wrapper)) {
  console.error(`✗ helper not found at ${dir}\n  Run the setup from the extension (Media tab → Set up), or pass --dir.`);
  process.exit(1);
}
console.log(`helper: ${dir}`);

// ---- start the host exactly like the browser does ----
const host = IS_WIN
  ? spawn(`"${wrapper}"`, [], { shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  : spawn(wrapper, [], { stdio: ["pipe", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write(`  [host stderr] ${d}`));

const listeners = [];
let buf = Buffer.alloc(0);
host.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (buf.length < 4) return;
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) return;
    const msg = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
    buf = buf.subarray(4 + n);
    for (const l of [...listeners]) l(msg);
  }
});
function send(obj) {
  const j = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(4);
  h.writeUInt32LE(j.length, 0);
  host.stdin.write(Buffer.concat([h, j]));
}
function waitFor(pred, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      listeners.splice(listeners.indexOf(l), 1);
      reject(new Error(`${label}: no reply within ${ms / 1000}s`));
    }, ms);
    const l = (m) => {
      if (!pred(m)) return;
      clearTimeout(t);
      listeners.splice(listeners.indexOf(l), 1);
      resolve(m);
    };
    listeners.push(l);
  });
}
const fmtBytes = (n) => (n ? `${(n / 1048576).toFixed(1)} MB` : "?");

(async () => {
  let ok = true;
  // ---- 1. ping ----
  const t0 = Date.now();
  send({ type: "ping", force: true });
  let pong;
  try {
    pong = await waitFor((m) => m.type === "pong", 90000, "ping");
  } catch (e) {
    console.error(`✗ ${e.message}`);
    host.kill();
    process.exit(1);
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✓ host ${pong.version} answered in ${dt}s (node ${pong.node}, ${pong.platform})`);
  if (pong.ytdlp) {
    console.log(`✓ yt-dlp ${pong.ytdlp.version}${pong.ytdlp.helper ? " (bundled)" : ` (${pong.ytdlp.path})`}`);
  } else {
    console.error("✗ yt-dlp not found by the host");
    ok = false;
  }
  if (pong.ffmpeg) console.log(`✓ ffmpeg ${pong.ffmpeg.version}`);
  else console.log("! ffmpeg missing: video+audio can't be merged, best quality limited");
  console.log(`  downloads go to ${pong.outputDir}`);
  // The host runs a background `yt-dlp -U` once a day right after a ping;
  // give it a moment so the result shows up here (and so killing the host
  // doesn't cut it off mid-write).
  try {
    const u = await waitFor((m) => m.type === "updated" && m.auto, 4000, "auto-update");
    console.log(u.updated ? `✓ background update: yt-dlp updated to ${u.version}` : u.ok ? "✓ background update check: already the latest" : `! background update failed: ${(u.output || "").split("\n").pop()}`);
  } catch {
    console.log("  (background update check not due or still running)");
  }

  // ---- 2. download ----
  const url = opt("--url", flag("--download") ? DEFAULT_URL : null);
  if (ok && url) {
    const out = path.join(os.tmpdir(), `combobreaker-smoke-${Date.now()}`);
    fs.mkdirSync(out, { recursive: true });
    const quality = opt("--quality", "480");
    console.log(`\ndownloading ${url} at ${quality} → ${out}`);
    const t1 = Date.now();
    let last = "";
    const progress = (m) => {
      if (m.type === "progress") {
        const s = m.status === "updating" ? "updating yt-dlp…" : `${m.status}${m.percent != null ? ` ${m.percent.toFixed(0)}%` : ""}${m.stage ? ` (${m.stage})` : ""}`;
        if (s !== last) {
          process.stdout.write(`  ${s}\n`);
          last = s;
        }
      } else if (m.type === "log") {
        for (const line of m.lines || []) process.stdout.write(`  ${line}\n`);
      }
    };
    listeners.push(progress);
    send({ type: "download", id: "smoke", url, quality, preferMp4: true, outputDir: out });
    let end;
    try {
      end = await waitFor((m) => (m.type === "done" || m.type === "error") && m.id === "smoke", 300000, "download");
    } catch (e) {
      end = { type: "error", message: e.message };
    }
    listeners.splice(listeners.indexOf(progress), 1);
    const secs = ((Date.now() - t1) / 1000).toFixed(1);
    if (end.type === "done") {
      const size = end.filepath && fs.existsSync(end.filepath) ? fs.statSync(end.filepath).size : 0;
      console.log(`✓ downloaded in ${secs}s: ${end.filepath} (${fmtBytes(size)})`);
      if (!flag("--keep")) {
        fs.rmSync(out, { recursive: true, force: true });
        console.log("  (deleted; pass --keep to keep it)");
      }
    } else {
      ok = false;
      console.error(`✗ download failed after ${secs}s: ${end.message}`);
      if (/sign in to confirm|not a bot/i.test(end.message || "")) {
        console.error("  This is YouTube's bot check for your network, not a broken helper.\n  In the extension: Options › Downloads › \"Use my browser's cookies\".");
      } else if (end.log) {
        console.error("  last log lines:\n" + end.log.slice(-8).map((l) => `    ${l}`).join("\n"));
      }
    }
  } else if (!url) {
    console.log("\n(pass --download to also test a real download)");
  }

  host.kill();
  process.exit(ok ? 0 : 1);
})();
