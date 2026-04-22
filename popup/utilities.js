// Tier-2 utility-belt tools that live as collapsible <details> in the popup's
// Tools pane. Each section is initialised lazily-ish: handlers are wired on
// load (cheap) and the heavier work (rendering QR, computing diffs, etc.)
// only runs when the user opens the relevant <details> or types into it.
//
// Everything here is pure client-side. Zero network requests.
//
// Public API:
//   initUtilities({ tab, status })
//
// `status(text, kind)` is the same toast used by the rest of popup.js.
// `tab` is the active chrome.tabs.Tab when the popup opened.

const $ = (id) => document.getElementById(id);

export function initUtilities({ tab, status }) {
  initQR(tab, status);
  initJWT();
  initEncoder(status);
  initRegex();
  initTimestamp();
  initColor();
  initDiff(status);
  initFakeData(status);
  initGenerator(status);
}

// ─────────────────── shared helpers ───────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function copy(text, status, label) {
  try {
    await navigator.clipboard.writeText(text);
    if (status) status(`${label || "Copied"}`, "ok");
    return true;
  } catch (e) {
    if (status) status(`Copy failed: ${e.message}`, "err");
    return false;
  }
}

// ─────────────────── QR code ───────────────────
// Uses the vendored qrcode-generator (window.qrcode). Renders to canvas with
// auto type-number selection. Falls back to lower EC level if the input is
// too long for typeNumber 40 (rare in practice).

function initQR(tab, status) {
  const det = document.querySelector('details[data-util="qr"]');
  const ta = $("qr-text");
  const ec = $("qr-ec");
  const canvas = $("qr-canvas");
  const note = $("qr-note");
  const reset = $("qr-reset");
  const save = $("qr-save");

  function render() {
    const text = ta.value;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!text) {
      note.textContent = "Enter text or paste a URL.";
      return;
    }
    let qr;
    try {
      qr = window.qrcode(0, ec.value);
      qr.addData(text);
      qr.make();
    } catch (e) {
      // Try downgrading EC level once.
      try {
        qr = window.qrcode(0, "L");
        qr.addData(text);
        qr.make();
        note.textContent = `Too long for ${ec.value}; rendered at L instead.`;
      } catch (e2) {
        note.textContent = `Couldn't encode: ${e2.message || e2}`;
        return;
      }
    }
    const count = qr.getModuleCount();
    const size = canvas.width;
    const scale = Math.floor(size / (count + 4));
    const px = scale * count;
    const offset = Math.floor((size - px) / 2);
    ctx.fillStyle = "#000";
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(offset + c * scale, offset + r * scale, scale, scale);
        }
      }
    }
    note.textContent = `${text.length} char${text.length === 1 ? "" : "s"} · ${count}×${count} modules · EC ${ec.value}`;
  }

  function setUrlFromTab() {
    if (tab && tab.url) ta.value = tab.url;
    render();
  }

  ta.addEventListener("input", render);
  ec.addEventListener("change", render);
  reset.addEventListener("click", setUrlFromTab);

  save.addEventListener("click", async () => {
    try {
      const url = canvas.toDataURL("image/png");
      await chrome.downloads.download({
        url,
        filename: "combobreaker/qrcode.png",
        saveAs: false,
      });
      status("QR saved to Downloads", "ok");
    } catch (e) {
      status(`Save failed: ${e.message}`, "err");
    }
  });

  // First render only happens when the section is first opened, so the
  // canvas isn't computed for users who never open it.
  let inited = false;
  det.addEventListener("toggle", () => {
    if (det.open && !inited) {
      inited = true;
      setUrlFromTab();
    }
  });
}

// ─────────────────── JWT decoder ───────────────────

function initJWT() {
  const inp = $("jwt-input");
  const statusEl = $("jwt-status");
  const headerSec = $("jwt-header-section");
  const payloadSec = $("jwt-payload-section");
  const timesSec = $("jwt-times-section");

  function setStatus(text, cls) {
    statusEl.className = "util-note" + (cls ? " " + cls : "");
    statusEl.textContent = text || "";
  }

  function b64urlDecode(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  function fmtDate(unix) {
    const d = new Date(unix * 1000);
    if (isNaN(d.getTime())) return "(invalid)";
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  }

  function relTime(deltaSec) {
    const abs = Math.abs(deltaSec);
    const dir = deltaSec >= 0 ? "in " : "";
    const suffix = deltaSec >= 0 ? "" : " ago";
    if (abs < 60) return `${dir}${Math.round(abs)}s${suffix}`;
    if (abs < 3600) return `${dir}${Math.round(abs / 60)}m${suffix}`;
    if (abs < 86400) return `${dir}${Math.round(abs / 3600)}h${suffix}`;
    if (abs < 86400 * 30) return `${dir}${Math.round(abs / 86400)}d${suffix}`;
    return `${dir}${Math.round(abs / (86400 * 30))}mo${suffix}`;
  }

  function decode() {
    const raw = inp.value.trim();
    if (!raw) {
      setStatus("");
      headerSec.hidden = payloadSec.hidden = timesSec.hidden = true;
      return;
    }
    const parts = raw.split(".");
    if (parts.length < 2 || parts.length > 3) {
      setStatus("Not a JWT (expected 2 or 3 dot-separated parts).", "err");
      headerSec.hidden = payloadSec.hidden = timesSec.hidden = true;
      return;
    }
    let header, payload;
    try {
      header = JSON.parse(b64urlDecode(parts[0]));
    } catch (e) {
      setStatus(`Header decode failed: ${e.message}`, "err");
      headerSec.hidden = payloadSec.hidden = timesSec.hidden = true;
      return;
    }
    try {
      payload = JSON.parse(b64urlDecode(parts[1]));
    } catch (e) {
      setStatus(`Payload decode failed: ${e.message}`, "err");
      headerSec.hidden = payloadSec.hidden = timesSec.hidden = true;
      return;
    }

    $("jwt-header").textContent = JSON.stringify(header, null, 2);
    $("jwt-payload").textContent = JSON.stringify(payload, null, 2);
    headerSec.hidden = false;
    payloadSec.hidden = false;

    const now = Math.floor(Date.now() / 1000);
    const rows = [];
    if (typeof payload.iss === "string") rows.push(["iss", payload.iss, ""]);
    if (typeof payload.sub === "string" || typeof payload.sub === "number") rows.push(["sub", String(payload.sub), ""]);
    if (typeof payload.aud === "string") rows.push(["aud", payload.aud, ""]);
    if (typeof payload.iat === "number") rows.push(["iat", `${fmtDate(payload.iat)} (${relTime(payload.iat - now)})`, ""]);
    if (typeof payload.nbf === "number") {
      const ok = payload.nbf <= now;
      rows.push(["nbf", `${fmtDate(payload.nbf)} (${relTime(payload.nbf - now)})`, ok ? "exp-ok" : "exp-bad"]);
    }
    if (typeof payload.exp === "number") {
      const ok = payload.exp > now;
      rows.push(["exp", `${fmtDate(payload.exp)} (${relTime(payload.exp - now)})`, ok ? "exp-ok" : "exp-bad"]);
    }

    const grid = $("jwt-times");
    grid.innerHTML = "";
    if (rows.length) {
      timesSec.hidden = false;
      for (const [k, v, cls] of rows) {
        const lbl = document.createElement("div");
        lbl.className = "label";
        lbl.textContent = k;
        const val = document.createElement("div");
        val.className = "val" + (cls ? " " + cls : "");
        val.textContent = v;
        grid.appendChild(lbl);
        grid.appendChild(val);
      }
    } else {
      timesSec.hidden = true;
    }

    const alg = (header && header.alg) || "?";
    const expNote =
      typeof payload.exp === "number"
        ? payload.exp > now
          ? `, expires ${relTime(payload.exp - now)}`
          : `, expired ${relTime(payload.exp - now)}`
        : "";
    setStatus(`alg: ${alg}${expNote}. Signature is NOT verified.`, "ok");
  }

  inp.addEventListener("input", decode);
}

// ─────────────────── Encoder / decoder ───────────────────

function initEncoder(status) {
  const mode = $("enc-mode");
  const inp = $("enc-input");
  const out = $("enc-output");
  const stat = $("enc-status");

  function setStatus(t, cls) {
    stat.className = "util-note" + (cls ? " " + cls : "");
    stat.textContent = t || "";
  }

  function utf8ToBytes(s) {
    return new TextEncoder().encode(s);
  }
  function bytesToUtf8(b) {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  }
  function bytesToBase64(b, urlSafe = false) {
    let bin = "";
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    let res = btoa(bin);
    if (urlSafe) res = res.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return res;
  }
  function base64ToBytes(s, urlSafe = false) {
    let t = s.trim();
    if (urlSafe) t = t.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    const bin = atob(t);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  const HTML_ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function htmlEncode(s) {
    return s.replace(/[&<>"']/g, (c) => HTML_ENT[c]);
  }
  function htmlDecode(s) {
    const tmp = document.createElement("textarea");
    tmp.innerHTML = s;
    return tmp.value;
  }

  function run(direction) {
    const m = mode.value;
    const text = inp.value;
    if (!text) { out.value = ""; setStatus(""); return; }
    try {
      let result;
      if (direction === "encode") {
        switch (m) {
          case "base64":     result = bytesToBase64(utf8ToBytes(text)); break;
          case "base64url":  result = bytesToBase64(utf8ToBytes(text), true); break;
          case "url":        result = encodeURI(text); break;
          case "urlcomp":    result = encodeURIComponent(text); break;
          case "hex":        result = Array.from(utf8ToBytes(text), (b) => b.toString(16).padStart(2, "0")).join(""); break;
          case "html":       result = htmlEncode(text); break;
        }
      } else {
        switch (m) {
          case "base64":     result = bytesToUtf8(base64ToBytes(text)); break;
          case "base64url":  result = bytesToUtf8(base64ToBytes(text, true)); break;
          case "url":        result = decodeURI(text); break;
          case "urlcomp":    result = decodeURIComponent(text); break;
          case "hex": {
            const t = text.replace(/\s+/g, "");
            if (!/^[0-9a-fA-F]*$/.test(t) || t.length % 2) throw new Error("not valid hex");
            const arr = new Uint8Array(t.length / 2);
            for (let i = 0; i < arr.length; i++) arr[i] = parseInt(t.substr(i * 2, 2), 16);
            result = bytesToUtf8(arr); break;
          }
          case "html":       result = htmlDecode(text); break;
        }
      }
      out.value = result;
      setStatus(`${direction === "encode" ? "Encoded" : "Decoded"} ${text.length} → ${result.length} chars`, "ok");
    } catch (e) {
      out.value = "";
      setStatus(`${direction} failed: ${e.message || e}`, "err");
    }
  }

  $("enc-encode").addEventListener("click", () => run("encode"));
  $("enc-decode").addEventListener("click", () => run("decode"));
  $("enc-swap").addEventListener("click", () => {
    inp.value = out.value;
    out.value = "";
    setStatus("Output → input", "ok");
  });
  $("enc-copy").addEventListener("click", () => {
    if (!out.value) return;
    copy(out.value, status, "Output copied");
  });
  // Live re-encode when mode changes (assume current input wants encoding).
  mode.addEventListener("change", () => {
    if (inp.value) run("encode");
  });
}

// ─────────────────── Regex tester ───────────────────

function initRegex() {
  const pat = $("re-pattern");
  const flags = $("re-flags");
  const text = $("re-text");
  const out = $("re-highlight");
  const count = $("re-count");
  const errEl = $("re-error");

  function update() {
    const p = pat.value;
    const f = flags.value;
    const t = text.value;
    errEl.textContent = "";
    if (!p) {
      out.textContent = t;
      count.textContent = t ? `${t.length} chars · enter pattern` : "no pattern";
      return;
    }
    let re;
    try {
      // Force /g so matchAll works regardless of user input.
      const userFlags = f.includes("g") ? f : f + "g";
      re = new RegExp(p, userFlags);
    } catch (e) {
      errEl.textContent = `Invalid regex: ${e.message}`;
      out.textContent = t;
      count.textContent = "—";
      return;
    }

    const matches = [...t.matchAll(re)];
    if (!matches.length) {
      out.textContent = t;
      count.textContent = "no matches";
      return;
    }

    let html = "";
    let cursor = 0;
    let i = 0;
    for (const m of matches) {
      const start = m.index;
      const end = start + m[0].length;
      if (end <= start) {
        // Zero-width match — highlight a cursor and advance to avoid infinite loop.
        html += escapeHtml(t.slice(cursor, start)) + `<mark class="${i % 2 ? "alt" : ""}">⌷</mark>`;
        cursor = start + 1;
      } else {
        html += escapeHtml(t.slice(cursor, start));
        html += `<mark class="${i % 2 ? "alt" : ""}">${escapeHtml(t.slice(start, end))}</mark>`;
        cursor = end;
      }
      i++;
    }
    html += escapeHtml(t.slice(cursor));
    out.innerHTML = html;
    count.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
  }

  pat.addEventListener("input", update);
  flags.addEventListener("input", update);
  text.addEventListener("input", update);
}

// ─────────────────── Timestamp ───────────────────

function initTimestamp() {
  const unix = $("ts-unix");
  const iso = $("ts-iso");
  const rows = $("ts-rows");
  const status = $("ts-status");
  const nowDisplay = $("ts-now-display");

  function render(ms) {
    const d = new Date(ms);
    if (isNaN(d.getTime())) {
      rows.innerHTML = "";
      status.className = "util-note err";
      status.textContent = "Invalid date";
      return;
    }
    status.className = "util-note muted";
    const sec = Math.floor(ms / 1000);
    const items = [
      ["unix s", String(sec)],
      ["unix ms", String(ms)],
      ["ISO", d.toISOString()],
      ["UTC", d.toUTCString()],
      ["local", d.toString().replace(/\s\(.*\)$/, "")],
      ["rel", relTime((ms - Date.now()) / 1000)],
    ];
    rows.innerHTML = "";
    for (const [k, v] of items) {
      const lbl = document.createElement("div");
      lbl.className = "label";
      lbl.textContent = k;
      const val = document.createElement("div");
      val.className = "val";
      val.textContent = v;
      val.title = "Click to copy";
      val.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(v);
          status.className = "util-note ok";
          status.textContent = `Copied "${k}"`;
        } catch {}
      });
      rows.appendChild(lbl);
      rows.appendChild(val);
    }
  }

  function relTime(deltaSec) {
    const abs = Math.abs(deltaSec);
    const dir = deltaSec >= 0 ? "in " : "";
    const suf = deltaSec >= 0 ? "" : " ago";
    if (abs < 60) return `${dir}${Math.round(abs)}s${suf}`;
    if (abs < 3600) return `${dir}${Math.round(abs / 60)}m${suf}`;
    if (abs < 86400) return `${dir}${Math.round(abs / 3600)}h${suf}`;
    if (abs < 86400 * 365) return `${dir}${Math.round(abs / 86400)}d${suf}`;
    return `${dir}${Math.round(abs / (86400 * 365))}y${suf}`;
  }

  unix.addEventListener("input", () => {
    const t = unix.value.trim();
    if (!t) { rows.innerHTML = ""; status.textContent = ""; return; }
    if (!/^-?\d+$/.test(t)) { status.className = "util-note err"; status.textContent = "Digits only"; return; }
    const n = Number(t);
    // Heuristic: treat values < 1e12 as seconds, otherwise ms.
    const ms = Math.abs(n) < 1e12 ? n * 1000 : n;
    render(ms);
    iso.value = isNaN(new Date(ms).getTime()) ? "" : new Date(ms).toISOString();
  });

  iso.addEventListener("input", () => {
    const t = iso.value.trim();
    if (!t) { rows.innerHTML = ""; status.textContent = ""; return; }
    const d = new Date(t);
    if (isNaN(d.getTime())) { status.className = "util-note err"; status.textContent = "Unparseable"; return; }
    render(d.getTime());
    unix.value = String(Math.floor(d.getTime() / 1000));
  });

  $("ts-now").addEventListener("click", () => {
    const ms = Date.now();
    unix.value = String(Math.floor(ms / 1000));
    iso.value = new Date(ms).toISOString();
    render(ms);
  });

  // Show a live "now" badge in the bar.
  const tickNow = () => {
    const d = new Date();
    nowDisplay.textContent = `now: ${d.toISOString().replace(/\.\d+Z$/, "Z")} (${Math.floor(d.getTime() / 1000)})`;
  };
  tickNow();
  setInterval(tickNow, 1000);
}

// ─────────────────── Color converter / contrast ───────────────────

function initColor() {
  const fg = $("col-fg");
  const fgText = $("col-fg-text");
  const bg = $("col-bg");
  const bgText = $("col-bg-text");
  const preview = $("col-preview");
  const fgOut = $("col-fg-out");
  const bgOut = $("col-bg-out");
  const contrast = $("col-contrast");
  const status = $("col-status");

  function setStatus(t, cls) {
    status.className = "util-note" + (cls ? " " + cls : " muted");
    status.textContent = t || "";
  }

  // Returns {r,g,b,a} 0-255 / 0-1 or null.
  function parseColor(s) {
    s = String(s).trim();
    if (!s) return null;
    let m;
    if ((m = s.match(/^#([0-9a-f]{3,8})$/i))) {
      const h = m[1];
      let r, g, b, a = 1;
      if (h.length === 3 || h.length === 4) {
        r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16);
        if (h.length === 4) a = parseInt(h[3] + h[3], 16) / 255;
      } else if (h.length === 6 || h.length === 8) {
        r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
        if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
      } else { return null; }
      return { r, g, b, a };
    }
    if ((m = s.match(/^rgba?\(([^)]+)\)$/i))) {
      const parts = m[1].split(/[,\s/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const r = clamp255(parseFloat(parts[0]));
      const g = clamp255(parseFloat(parts[1]));
      const b = clamp255(parseFloat(parts[2]));
      const a = parts[3] != null ? parseAlpha(parts[3]) : 1;
      return { r, g, b, a };
    }
    if ((m = s.match(/^hsla?\(([^)]+)\)$/i))) {
      const parts = m[1].split(/[,\s/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const h = parseHue(parts[0]);
      const sat = parseFloat(parts[1]) / 100;
      const l = parseFloat(parts[2]) / 100;
      const a = parts[3] != null ? parseAlpha(parts[3]) : 1;
      const { r, g, b } = hslToRgb(h, sat, l);
      return { r, g, b, a };
    }
    return null;
  }
  function clamp255(n) { return Math.max(0, Math.min(255, Math.round(n))); }
  function parseAlpha(s) {
    if (s.endsWith("%")) return Math.max(0, Math.min(1, parseFloat(s) / 100));
    return Math.max(0, Math.min(1, parseFloat(s)));
  }
  function parseHue(s) {
    if (s.endsWith("deg")) return parseFloat(s);
    if (s.endsWith("rad")) return (parseFloat(s) * 180) / Math.PI;
    if (s.endsWith("turn")) return parseFloat(s) * 360;
    return parseFloat(s);
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s; const l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  }

  // sRGB → linear → OKLab → OKLCH (Björn Ottosson, 2020)
  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function rgbToOklch(r, g, b) {
    const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
    const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
    const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
    const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
    const C = Math.sqrt(a * a + bb * bb);
    let h = (Math.atan2(bb, a) * 180) / Math.PI;
    if (h < 0) h += 360;
    return { L: L * 100, C, h };
  }

  function relLum(r, g, b) {
    const a = [r, g, b].map((v) => srgbToLinear(v));
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function contrastRatio(c1, c2) {
    const l1 = relLum(c1.r, c1.g, c1.b);
    const l2 = relLum(c2.r, c2.g, c2.b);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  }

  function fmtAll(c) {
    if (!c) return "(invalid)";
    const hex =
      "#" + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("") +
      (c.a < 1 ? Math.round(c.a * 255).toString(16).padStart(2, "0") : "");
    const rgb = c.a < 1
      ? `rgb(${c.r} ${c.g} ${c.b} / ${(c.a * 100).toFixed(0)}%)`
      : `rgb(${c.r}, ${c.g}, ${c.b})`;
    const hsl = rgbToHsl(c.r, c.g, c.b);
    const hslStr = `hsl(${hsl.h.toFixed(0)} ${hsl.s.toFixed(0)}% ${hsl.l.toFixed(0)}%)`;
    const oklch = rgbToOklch(c.r, c.g, c.b);
    const oklchStr = `oklch(${oklch.L.toFixed(1)}% ${oklch.C.toFixed(3)} ${oklch.h.toFixed(1)})`;
    return `${hex}\n${rgb}\n${hslStr}\n${oklchStr}`;
  }

  function rgbCss(c) { return c ? `rgba(${c.r},${c.g},${c.b},${c.a})` : "transparent"; }

  function update(source) {
    const fgC = parseColor(fgText.value);
    const bgC = parseColor(bgText.value);
    if (fgC && source !== "fg-color") fg.value = "#" + [fgC.r, fgC.g, fgC.b].map((n) => n.toString(16).padStart(2, "0")).join("");
    if (bgC && source !== "bg-color") bg.value = "#" + [bgC.r, bgC.g, bgC.b].map((n) => n.toString(16).padStart(2, "0")).join("");
    fgOut.textContent = fmtAll(fgC);
    bgOut.textContent = fmtAll(bgC);
    preview.style.color = rgbCss(fgC);
    preview.style.background = rgbCss(bgC);
    if (fgC && bgC) {
      const ratio = contrastRatio(fgC, bgC);
      contrast.innerHTML = "";
      const r = document.createElement("span");
      r.className = "ratio";
      r.textContent = `${ratio.toFixed(2)} : 1`;
      contrast.appendChild(r);
      const tests = [
        ["AA normal", ratio >= 4.5],
        ["AA large", ratio >= 3],
        ["AAA normal", ratio >= 7],
        ["AAA large", ratio >= 4.5],
      ];
      for (const [label, pass] of tests) {
        const p = document.createElement("span");
        p.className = "pill " + (pass ? "pass" : "fail");
        p.textContent = `${label} ${pass ? "✓" : "✗"}`;
        contrast.appendChild(p);
      }
      setStatus("");
    } else {
      contrast.innerHTML = "";
      setStatus(fgC || bgC ? "Enter both colours for a contrast ratio." : "");
    }
  }

  fgText.addEventListener("input", () => update("fg-text"));
  bgText.addEventListener("input", () => update("bg-text"));
  fg.addEventListener("input", () => { fgText.value = fg.value; update("fg-color"); });
  bg.addEventListener("input", () => { bgText.value = bg.value; update("bg-color"); });

  update("init");
}

// ─────────────────── Diff viewer ───────────────────

function initDiff(status) {
  const a = $("diff-a");
  const b = $("diff-b");
  const out = $("diff-out");
  const stats = $("diff-stats");
  const mode = $("diff-mode");

  function update() {
    const aT = a.value;
    const bT = b.value;
    if (!aT && !bT) { out.innerHTML = ""; stats.textContent = ""; return; }
    if (mode.value === "word") {
      const tokensA = tokenize(aT);
      const tokensB = tokenize(bT);
      const ops = coalesce(diff(tokensA, tokensB));
      let added = 0, removed = 0;
      let html = "";
      for (const [op, val] of ops) {
        if (op === "=") html += escapeHtml(val);
        else if (op === "+") { html += `<ins>${escapeHtml(val)}</ins>`; added += val.length; }
        else { html += `<del>${escapeHtml(val)}</del>`; removed += val.length; }
      }
      out.innerHTML = html;
      stats.textContent = `+${added} −${removed}`;
    } else {
      const linesA = aT.split("\n");
      const linesB = bT.split("\n");
      const ops = diff(linesA, linesB);
      const lines = unifiedLines(ops, 3);
      let added = 0, removed = 0;
      let html = "";
      for (const line of lines) {
        const cls =
          line[0] === "+" ? "add"
          : line[0] === "-" ? "del"
          : line[0] === "@" ? "hunk"
          : "ctx";
        if (line[0] === "+") added++;
        else if (line[0] === "-") removed++;
        html += `<span class="${cls}">${escapeHtml(line)}</span>\n`;
      }
      out.innerHTML = html;
      stats.textContent = `+${added} −${removed} lines`;
    }
  }

  function tokenize(s) {
    // Word-level tokenization preserving whitespace as its own token.
    return s.match(/\s+|[^\s]+/g) || [];
  }

  // LCS diff. Returns array of [op, value] one entry per input element,
  // where op ∈ "=", "+", "-". Caller can coalesce same-op runs as needed
  // (word mode does, line mode doesn't because joining would lose newlines).
  function diff(a, b) {
    const n = a.length, m = b.length;
    if (n === 0) return b.map((v) => ["+", v]);
    if (m === 0) return a.map((v) => ["-", v]);
    if (n * m > 250000) {
      // Bail out for very large diffs: just emit as a single replace.
      return [...a.map((v) => ["-", v]), ...b.map((v) => ["+", v])];
    }
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
        else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const ops = [];
    let i = n, j = m;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) { ops.push(["=", a[i - 1]]); i--; j--; }
      else if (dp[i - 1][j] >= dp[i][j - 1]) { ops.push(["-", a[i - 1]]); i--; }
      else { ops.push(["+", b[j - 1]]); j--; }
    }
    while (i > 0) { ops.push(["-", a[--i]]); }
    while (j > 0) { ops.push(["+", b[--j]]); }
    ops.reverse();
    return ops;
  }

  function coalesce(ops) {
    const out = [];
    for (const [op, v] of ops) {
      const last = out[out.length - 1];
      if (last && last[0] === op) last[1] += v;
      else out.push([op, v]);
    }
    return out;
  }

  // Convert per-line ops into unified-diff hunks with `context` equal lines
  // around each change. ops is one entry per line.
  function unifiedLines(ops, context) {
    const out = [];
    let i = 0;
    let aLine = 1, bLine = 1;
    while (i < ops.length) {
      let firstChange = i;
      while (firstChange < ops.length && ops[firstChange][0] === "=") firstChange++;
      if (firstChange >= ops.length) break;
      const hunkStart = Math.max(i, firstChange - context);
      for (let k = i; k < hunkStart; k++) {
        if (ops[k][0] === "=") { aLine++; bLine++; }
      }
      let hunkEnd = firstChange;
      let runEq = 0;
      while (hunkEnd < ops.length) {
        if (ops[hunkEnd][0] === "=") { runEq++; if (runEq > context * 2) break; }
        else { runEq = 0; }
        hunkEnd++;
      }
      const trimmedEnd = hunkEnd - Math.max(0, runEq - context);
      let aCount = 0, bCount = 0;
      for (let k = hunkStart; k < trimmedEnd; k++) {
        const op = ops[k][0];
        if (op === "=" || op === "-") aCount++;
        if (op === "=" || op === "+") bCount++;
      }
      out.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`);
      for (let k = hunkStart; k < trimmedEnd; k++) {
        const [op, v] = ops[k];
        if (op === "=") { out.push(" " + v); aLine++; bLine++; }
        else if (op === "-") { out.push("-" + v); aLine++; }
        else { out.push("+" + v); bLine++; }
      }
      for (let k = trimmedEnd; k < hunkEnd; k++) {
        if (ops[k][0] === "=") { aLine++; bLine++; }
      }
      i = hunkEnd;
    }
    return out;
  }

  $("diff-copy").addEventListener("click", () => {
    if (!out.textContent) return;
    copy(out.textContent, status, "Diff copied");
  });
  a.addEventListener("input", update);
  b.addEventListener("input", update);
  mode.addEventListener("change", update);
}

// ─────────────────── Fake data / lorem ───────────────────

const LOREM = (
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor " +
  "incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis " +
  "nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat " +
  "duis aute irure dolor in reprehenderit voluptate velit esse cillum dolore eu " +
  "fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in " +
  "culpa qui officia deserunt mollit anim id est laborum"
).split(" ");

const FIRST_NAMES = [
  "Alex", "Amelia", "Avery", "Blake", "Cameron", "Casey", "Charlie", "Dakota",
  "Drew", "Ellis", "Emerson", "Finley", "Harper", "Hayden", "Jamie", "Jordan",
  "Kai", "Kendall", "Logan", "Morgan", "Nico", "Parker", "Quinn", "Reese",
  "Riley", "River", "Robin", "Rowan", "Sage", "Sam", "Sawyer", "Skyler",
  "Sloan", "Spencer", "Sydney", "Taylor",
];
const LAST_NAMES = [
  "Adams", "Bennett", "Brooks", "Cohen", "Cruz", "Diaz", "Donovan", "Fischer",
  "Garcia", "Hayes", "Holloway", "Jansen", "Kim", "Lee", "Lopez", "Martin",
  "Mendoza", "Morales", "Murphy", "Nguyen", "Okafor", "Park", "Patel", "Reyes",
  "Rivera", "Rossi", "Schmidt", "Singh", "Sullivan", "Tanaka", "Walker",
  "Williams", "Yamamoto", "Zhang",
];
const STREETS = ["Elm", "Oak", "Maple", "Cedar", "Pine", "Birch", "Willow", "Ash", "Cypress", "Juniper", "Magnolia", "Redwood"];
const SUFFIXES = ["St", "Ave", "Rd", "Blvd", "Ln", "Way", "Ct"];
const CITIES = ["Springfield", "Riverdale", "Lakeside", "Hillview", "Brookfield", "Ashford", "Glendale", "Westbridge", "Cedar Falls", "Pinegrove"];
const STATES = ["CA", "NY", "TX", "FL", "IL", "WA", "OR", "MA", "CO", "GA"];
const EMAIL_DOMAINS = ["example.com", "example.org", "example.net", "test.local", "mailinator.com"];

// Test BIN prefixes commonly accepted by payment-gateway test modes.
// All of these are non-routable. Source: gateway docs (Stripe / Adyen).
const TEST_CC_PREFIXES = [
  { name: "Visa", prefix: "4242424242424242", len: 16 },
  { name: "Visa", prefix: "4000056655665556", len: 16 },
  { name: "Mastercard", prefix: "5555555555554444", len: 16 },
  { name: "Mastercard", prefix: "2223003122003222", len: 16 },
  { name: "Amex", prefix: "378282246310005", len: 15 },
  { name: "Discover", prefix: "6011111111111117", len: 16 },
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function fakeName() { return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`; }
function fakeEmail() {
  const f = pick(FIRST_NAMES).toLowerCase();
  const l = pick(LAST_NAMES).toLowerCase();
  const tag = Math.floor(Math.random() * 1000);
  return `${f}.${l}${tag}@${pick(EMAIL_DOMAINS)}`;
}
function fakePhone() {
  const a = 200 + Math.floor(Math.random() * 700);
  const b = 200 + Math.floor(Math.random() * 700);
  const c = 1000 + Math.floor(Math.random() * 9000);
  return `(${a}) ${b}-${c}`;
}
function fakeAddress() {
  const num = 10 + Math.floor(Math.random() * 9990);
  const street = `${pick(STREETS)} ${pick(SUFFIXES)}`;
  const city = pick(CITIES);
  const state = pick(STATES);
  const zip = 10000 + Math.floor(Math.random() * 89999);
  return `${num} ${street}, ${city}, ${state} ${zip}`;
}
function fakeCC() {
  // Returns a known test BIN verbatim so it's guaranteed to work in
  // sandbox modes — rotating these is what most form-fillers do.
  return pick(TEST_CC_PREFIXES);
}
function loremWords(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(pick(LOREM));
  return out.join(" ");
}
function loremSentence() {
  const len = 6 + Math.floor(Math.random() * 14);
  const s = loremWords(len);
  return s[0].toUpperCase() + s.slice(1) + ".";
}
function loremParagraph() {
  const n = 3 + Math.floor(Math.random() * 5);
  const out = [];
  for (let i = 0; i < n; i++) out.push(loremSentence());
  return out.join(" ");
}

function initFakeData(status) {
  const out = $("fake-out");
  const count = $("fake-count");

  document.querySelectorAll("[data-fake]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Math.max(1, Math.min(200, parseInt(count.value, 10) || 1));
      const kind = btn.dataset.fake;
      const lines = [];
      for (let i = 0; i < n; i++) {
        switch (kind) {
          case "name": lines.push(fakeName()); break;
          case "email": lines.push(fakeEmail()); break;
          case "phone": lines.push(fakePhone()); break;
          case "address": lines.push(fakeAddress()); break;
          case "cc": {
            const cc = fakeCC();
            lines.push(`${cc.name}: ${cc.prefix}  exp: ${String(Math.floor(Math.random() * 12) + 1).padStart(2, "0")}/${String(new Date().getFullYear() + 2 + Math.floor(Math.random() * 5)).slice(2)}  cvv: ${String(Math.floor(Math.random() * 900) + 100)}`);
            break;
          }
          case "lorem-w": lines.push(loremWords(1)); break;
          case "lorem-s": lines.push(loremSentence()); break;
          case "lorem-p": lines.push(loremParagraph()); break;
        }
      }
      // For paragraphs use double-newline separators; otherwise singles.
      out.value = lines.join(kind === "lorem-p" ? "\n\n" : "\n");
    });
  });

  $("fake-copy").addEventListener("click", () => {
    if (out.value) copy(out.value, status, "Copied");
  });
}

// ─────────────────── Password / UUID generator ───────────────────

const CHARSET = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digit: "0123456789",
  sym: "!@#$%^&*()-_=+[]{};:,.<>/?~",
};
const AMBIG = /[Il1O0o]/g;

function initGenerator(status) {
  const out = $("pw-out");
  const stat = $("pw-status");

  function setStatus(t, cls) {
    stat.className = "util-note" + (cls ? " " + cls : " muted");
    stat.textContent = t || "";
  }

  function makePassword() {
    let charset = "";
    if ($("pw-lower").checked) charset += CHARSET.lower;
    if ($("pw-upper").checked) charset += CHARSET.upper;
    if ($("pw-digit").checked) charset += CHARSET.digit;
    if ($("pw-sym").checked) charset += CHARSET.sym;
    if ($("pw-noambig").checked) charset = charset.replace(AMBIG, "");
    if (!charset) return "(pick a charset)";
    const len = Math.max(4, Math.min(128, parseInt($("pw-len").value, 10) || 20));
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    let s = "";
    for (let i = 0; i < len; i++) s += charset[buf[i] % charset.length];
    return s;
  }

  function entropyBits(pwLen) {
    let charset = "";
    if ($("pw-lower").checked) charset += CHARSET.lower;
    if ($("pw-upper").checked) charset += CHARSET.upper;
    if ($("pw-digit").checked) charset += CHARSET.digit;
    if ($("pw-sym").checked) charset += CHARSET.sym;
    if ($("pw-noambig").checked) charset = charset.replace(AMBIG, "");
    if (!charset.length) return 0;
    return Math.round(pwLen * Math.log2(charset.length));
  }

  $("pw-gen").addEventListener("click", () => {
    const n = Math.max(1, Math.min(50, parseInt($("pw-count").value, 10) || 1));
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(makePassword());
    out.value = lines.join("\n");
    const len = parseInt($("pw-len").value, 10) || 20;
    const e = entropyBits(len);
    setStatus(`${n} × ${len}-char password${n === 1 ? "" : "s"} · ~${e} bits entropy`, "ok");
  });
  $("pw-uuid").addEventListener("click", () => {
    const n = Math.max(1, Math.min(50, parseInt($("pw-count").value, 10) || 1));
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(crypto.randomUUID());
    out.value = lines.join("\n");
    setStatus(`${n} UUID v4${n === 1 ? "" : "s"}`, "ok");
  });
  $("pw-copy").addEventListener("click", () => {
    if (out.value) copy(out.value, status, "Copied");
  });
}
