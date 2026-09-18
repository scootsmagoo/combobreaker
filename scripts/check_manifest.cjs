#!/usr/bin/env node
// Static sanity checks that Chrome would otherwise only report at load time
// (or not at all):
//   - every file the manifest references exists
//   - DNR rulesets parse and have unique ids
//   - source files are valid UTF-8 with no BOM (see .editorconfig)
//
//   node scripts/check_manifest.cjs

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const errors = [];
const rel = (p) => path.join(ROOT, p);
const need = (p, why) => {
  if (!fs.existsSync(rel(p))) errors.push(`missing file: ${p} (${why})`);
};

const manifest = JSON.parse(fs.readFileSync(rel("manifest.json"), "utf8"));

if (!/^\d+(\.\d+){1,3}$/.test(manifest.version)) errors.push(`bad version: ${manifest.version}`);

for (const p of Object.values(manifest.icons || {})) need(p, "icons");
for (const p of Object.values((manifest.action || {}).default_icon || {})) need(p, "action icon");
if (manifest.action && manifest.action.default_popup) need(manifest.action.default_popup, "popup");
if (manifest.options_ui) need(manifest.options_ui.page, "options_ui");
if (manifest.side_panel) need(manifest.side_panel.default_path, "side_panel");
if (manifest.background) need(manifest.background.service_worker, "service worker");
for (const cs of manifest.content_scripts || []) {
  for (const p of [...(cs.js || []), ...(cs.css || [])]) need(p, "content_scripts");
}
for (const war of manifest.web_accessible_resources || []) {
  for (const p of war.resources || []) if (!p.includes("*")) need(p, "web_accessible_resources");
}

for (const rs of (manifest.declarative_net_request || {}).rule_resources || []) {
  need(rs.path, "DNR ruleset");
  try {
    const rules = JSON.parse(fs.readFileSync(rel(rs.path), "utf8"));
    const ids = new Set();
    for (const r of rules) {
      if (!Number.isInteger(r.id) || r.id < 1) errors.push(`${rs.path}: bad rule id ${r.id}`);
      if (ids.has(r.id)) errors.push(`${rs.path}: duplicate rule id ${r.id}`);
      ids.add(r.id);
    }
  } catch (e) {
    errors.push(`${rs.path}: ${e.message}`);
  }
}

// Static ES imports in extension modules must resolve — a typo here kills the
// whole service worker with an unhelpful "registration failed".
const IMPORT_RE = /^\s*import\s[^"']*["'](\.[^"']+)["']/gm;
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(rel(dir), { withFileTypes: true })) {
    const p = path.posix.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const SOURCE_DIRS = ["background", "content", "lib", "options", "popup", "setup", "tools", "viewer"];
const sources = SOURCE_DIRS.flatMap((d) => (fs.existsSync(rel(d)) ? walk(d) : []));
for (const f of sources) {
  const buf = fs.readFileSync(rel(f));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) errors.push(`${f}: has a UTF-8 BOM`);
  const text = buf.toString("utf8");
  if (text.includes("�")) errors.push(`${f}: not valid UTF-8 (or contains U+FFFD)`);
  if (f.endsWith(".js")) {
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = path.posix.join(path.posix.dirname(f), m[1]);
      if (!fs.existsSync(rel(target))) errors.push(`${f}: import not found: ${m[1]}`);
    }
  }
}

if (errors.length) {
  console.error(errors.map((e) => `  ✗ ${e}`).join("\n"));
  process.exit(1);
}
console.log(`manifest ok — v${manifest.version}, ${sources.length} source files checked`);
