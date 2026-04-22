const fs = require("fs");
const path = require("path");
const s = fs.readFileSync(path.join(__dirname, "../popup/popup.html"), "utf8");
const lines = s.split("\n");
for (let n = 0; n < lines.length; n++) {
  const line = lines[n];
  const bad = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i].codePointAt(0) > 127) bad.push({ i, c: line[i], h: line[i].codePointAt(0).toString(16) });
  }
  if (bad.length) console.log(n + 1, JSON.stringify(line.slice(0, 90)), bad);
}
