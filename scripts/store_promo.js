// Renders the optional Chrome Web Store promo images into docs/store/:
//   promo-small-440x280.png    small promo tile
//   promo-marquee-1400x560.png marquee promo tile
// Both are just the icon, the name and one line, on the icon's navy, which is
// what the store's own guidance asks for (simple, little text, no screenshots,
// no Chrome branding).
//
//   npm i --no-save puppeteer-core   (once)
//   node scripts/store_promo.js

const path = require("path");
const fs = require("fs");
const os = require("os");

let puppeteer;
try {
  puppeteer = require("puppeteer-core");
} catch {
  console.error("puppeteer-core missing: npm i --no-save puppeteer-core");
  process.exit(2);
}

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs", "store");
const CHROME =
  process.env.CHROME ||
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));

const icon = "data:image/png;base64," + fs.readFileSync(path.join(ROOT, "icons", "icon128.png")).toString("base64");

const TILES = [
  {
    file: "promo-small-440x280.png", w: 440, h: 280, icon: 112, name: 40, line: 17, gap: 28, features: false,
    tagline: "One privacy-respecting toolbox.<br>No telemetry, no account, open source.",
  },
  {
    file: "promo-marquee-1400x560.png", w: 1400, h: 560, icon: 224, name: 84, line: 30, gap: 56, features: true,
    tagline: "One privacy-respecting toolbox instead of a dozen small extensions.<br>No telemetry, no account, open source.",
  },
];

function html(t) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${t.w}px; height: ${t.h}px; overflow: hidden; }
    body {
      background: radial-gradient(120% 140% at 0% 0%, #17203a 0%, #101420 55%, #0b0e17 100%);
      color: #f3f5fb;
      font-family: -apple-system, "SF Pro Display", "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
      display: flex; align-items: center; justify-content: center;
      -webkit-font-smoothing: antialiased;
    }
    .row { display: flex; align-items: center; gap: ${t.gap}px; }
    img { width: ${t.icon}px; height: ${t.icon}px; display: block; }
    .name { font-size: ${t.name}px; font-weight: 700; letter-spacing: -0.02em; line-height: 1; margin: 0; }
    .name b { color: #ec4899; font-weight: 700; }
    .line { font-size: ${t.line}px; color: #b9c2d6; margin: ${Math.round(t.line * 0.55)}px 0 0; line-height: 1.3; }
    .feat { display: flex; gap: 14px; margin-top: ${Math.round(t.line * 0.9)}px; }
    .feat span { font-size: ${Math.round(t.line * 0.72)}px; color: #38bdf8; border: 1.5px solid rgba(56,189,248,.45); border-radius: 999px; padding: 6px 14px; }
  </style></head><body>
    <div class="row">
      <img src="${icon}" alt="">
      <div>
        <p class="name">Combo<b>Breaker</b></p>
        <p class="line">${t.tagline}</p>
        ${t.features ? '<div class="feat"><span>Blocking</span><span>Per-site JS &amp; CSS</span><span>Dark mode</span><span>Dev tools</span><span>Downloads</span></div>' : ""}
      </div>
    </div>
  </body></html>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-promo-")),
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    for (const t of TILES) {
      const page = await browser.newPage();
      await page.setViewport({ width: t.w, height: t.h, deviceScaleFactor: 1 });
      await page.setContent(html(t), { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      const file = path.join(OUT, t.file);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: t.w, height: t.h } });
      console.log(`${path.relative(ROOT, file)}  ${t.w}x${t.h}  ${Math.round(fs.statSync(file).size / 1024)} KB`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
