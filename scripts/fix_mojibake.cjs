/* Optional: repair common 3-code-unit mojibake in popup/ after bad encoding saves.
   Run: node scripts/fix_mojibake.cjs
   Prefer saving popup sources as UTF-8 (no BOM) in the editor. */
const fs = require("fs");
const path = require("path");
const P = path.join(__dirname, "..", "popup");
const PAIRS = [
  ["\u00e2\u20ac\u201d", "\u2014"],
  ["\u00e2\u20ac\u00a6", "\u2026"],
  ["\u00e2\u0161\u2122", "\u2699"],
  ["\u00e2\u201d\u20ac", ""],
  ["\u00e2\u2020\u2019", "\u2192"],
  ["\u00e2\u2020\u00bb", "\u21bb"],
  ["\u00e2\u20ac\u2122", "\u2019"],
  ["\u00c3\u2014", "\u00d7"],
  ["Lorem \u00c2\u00b6", "Lorem p"],
  ["" + "tab" + "\u00e2\u20ac\u2122" + "s", "tab's"],
];
for (const name of ["popup.html", "popup.js"]) {
  const f = path.join(P, name);
  const raw = fs.readFileSync(f, "utf8");
  let t = raw;
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  for (const [a, b] of PAIRS) t = t.split(a).join(b);
  if (t !== raw) fs.writeFileSync(f, t, "utf8");
}
