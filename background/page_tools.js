// On-demand page tools: tool launcher, full-page screenshot, encoding override.

import { siteKeyFromUrl } from "../lib/site.js";

// ---------- On-demand tool launcher ----------

const TOOL_FILES = {
  "color-picker": "tools/color_picker.js",
  ruler: "tools/ruler.js",
  whatfont: "tools/whatfont.js",
  trackers: "tools/trackers.js",
};

export async function launchTool(tool, tabIdOverride, sender) {
  const tabId =
    tabIdOverride ??
    sender?.tab?.id ??
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!tabId) throw new Error("no active tab");

  const file = TOOL_FILES[tool];
  if (!file) throw new Error(`unknown tool: ${tool}`);

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [file],
    world: "ISOLATED",
  });
  return { tabId, tool };
}

// ---------- Full-page screenshot (scroll + stitch) ----------

export async function captureFullPage(tabIdOverride) {
  const tabId =
    tabIdOverride ??
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!tabId) throw new Error("no active tab");

  const tab = await chrome.tabs.get(tabId);
  const windowId = tab.windowId;

  const [{ result: dims }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      docHeight: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      ),
      docWidth: Math.max(
        document.body.scrollWidth,
        document.documentElement.scrollWidth
      ),
      dpr: window.devicePixelRatio || 1,
    }),
  });

  const shots = [];
  let y = 0;
  while (y < dims.docHeight) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (yy) => window.scrollTo(0, yy),
      args: [y],
    });
    await new Promise((r) => setTimeout(r, 250));
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "png",
    });
    shots.push({ y, dataUrl });
    y += dims.innerHeight;
    await new Promise((r) => setTimeout(r, 100));
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (sx, sy) => window.scrollTo(sx, sy),
    args: [dims.scrollX, dims.scrollY],
  });

  const stitched = await stitchShots(shots, dims);
  const filename = `combobreaker-${siteKeyFromUrl(tab.url) || "page"}-${Date.now()}.png`;
  await chrome.downloads.download({
    url: stitched,
    filename,
    saveAs: false,
  });
  return { filename, count: shots.length };
}

async function stitchShots(shots, dims) {
  const totalHeight = dims.docHeight * dims.dpr;
  const totalWidth = dims.innerWidth * dims.dpr;
  const canvas = new OffscreenCanvas(totalWidth, totalHeight);
  const ctx = canvas.getContext("2d");

  for (const shot of shots) {
    const blob = await (await fetch(shot.dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const drawY = shot.y * dims.dpr;
    let sourceClipY = 0;
    let sourceClipHeight = bmp.height;
    if (drawY + bmp.height > totalHeight) {
      sourceClipHeight = totalHeight - drawY;
      sourceClipY = bmp.height - sourceClipHeight;
    }
    ctx.drawImage(
      bmp,
      0,
      sourceClipY,
      bmp.width,
      sourceClipHeight,
      0,
      drawY + sourceClipY,
      bmp.width,
      sourceClipHeight
    );
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------- Encoding override ----------
// Re-fetch the page bytes, decode with a chosen encoding, write into the tab.

export async function setEncoding(tabIdOverride, encoding) {
  const tabId =
    tabIdOverride ??
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!tabId) throw new Error("no active tab");
  if (!encoding) throw new Error("encoding required");

  const tab = await chrome.tabs.get(tabId);
  const url = tab.url;
  if (!/^https?:/.test(url)) throw new Error("only http(s) supported");

  const resp = await fetch(url, { credentials: "include" });
  const buf = await resp.arrayBuffer();
  const decoder = new TextDecoder(encoding, { fatal: false });
  const html = decoder.decode(buf);

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (h) => {
      document.open();
      document.write(h);
      document.close();
    },
    args: [html],
  });
  return { encoding };
}
