import { ensureSchema, getGlobal, getSite, setSite } from "../lib/storage.js";
import { siteKeyFromUrl, originPatternForSite } from "../lib/site.js";

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSchema();
  await applyAdblockState();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSchema();
  await applyAdblockState();
});

// ---------- Message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const result = await handleMessage(msg, sender);
      sendResponse({ ok: true, result });
    } catch (err) {
      console.error("[ComboBreaker] message error:", err);
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg?.type) {
    case "get-site-state":
      return await getSiteState(msg.siteKey);
    case "set-js-enabled":
      return await setJsEnabled(msg.siteKey, msg.enabled);
    case "set-site":
      return await setSite(msg.siteKey, msg.patch);
    case "toggle-darkmode":
      return await toggleDarkMode(msg.siteKey);
    case "launch-tool":
      return await launchTool(msg.tool, msg.tabId, sender);
    case "capture-fullpage":
      return await captureFullPage(msg.tabId);
    case "set-encoding":
      return await setEncoding(msg.tabId, msg.encoding);
    case "apply-adblock":
      return await applyAdblockState();
    default:
      throw new Error(`unknown message type: ${msg?.type}`);
  }
}

// ---------- Per-site JS toggle (chrome.contentSettings) ----------

async function getSiteState(siteKey) {
  if (!siteKey) return null;
  const settings = await getSite(siteKey);
  const global = await getGlobal();
  const jsEnabled = await getJavascriptSetting(siteKey);
  return { siteKey, settings, global, jsEnabled };
}

async function getJavascriptSetting(siteKey) {
  const pattern = originPatternForSite(siteKey);
  if (!pattern) return true;
  return new Promise((resolve) => {
    chrome.contentSettings.javascript.get(
      { primaryUrl: `https://${siteKey}/` },
      (details) => {
        if (chrome.runtime.lastError || !details) return resolve(true);
        resolve(details.setting !== "block");
      }
    );
  });
}

async function setJsEnabled(siteKey, enabled) {
  const pattern = originPatternForSite(siteKey);
  if (!pattern) throw new Error("cannot set JS for non-http site");
  await new Promise((resolve, reject) => {
    chrome.contentSettings.javascript.set(
      {
        primaryPattern: pattern,
        setting: enabled ? "allow" : "block",
        scope: "regular",
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      }
    );
  });
  return { jsEnabled: enabled };
}

// ---------- Dark mode toggle ----------

async function toggleDarkMode(siteKey) {
  if (!siteKey) return null;
  const current = await getSite(siteKey);
  const global = await getGlobal();
  const wasOn = current.darkMode == null ? global.defaultDarkMode : current.darkMode;
  const next = !wasOn;
  await setSite(siteKey, { darkMode: next });
  await broadcastToSite(siteKey, { type: "cb-dark-mode-changed", enabled: next });
  return { darkMode: next };
}

async function broadcastToSite(siteKey, payload) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (siteKeyFromUrl(t.url) === siteKey && t.id != null) {
      chrome.tabs.sendMessage(t.id, payload).catch(() => {});
    }
  }
}

// ---------- On-demand tool launcher ----------

const TOOL_FILES = {
  "color-picker": "tools/color_picker.js",
  ruler: "tools/ruler.js",
  whatfont: "tools/whatfont.js",
};

async function launchTool(tool, tabIdOverride, sender) {
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

async function captureFullPage(tabIdOverride) {
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

async function setEncoding(tabIdOverride, encoding) {
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

// ---------- Adblock toggle ----------

async function applyAdblockState() {
  const { adblockEnabled } = await getGlobal();
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    [adblockEnabled ? "enableRulesetIds" : "disableRulesetIds"]: [
      "combobreaker_basic_block",
    ],
  });
  return { adblockEnabled };
}

// ---------- Keyboard commands ----------

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const siteKey = siteKeyFromUrl(tab.url);
  if (!siteKey) return;

  switch (command) {
    case "toggle-darkmode":
      await toggleDarkMode(siteKey);
      break;
    case "toggle-js": {
      const current = await getJavascriptSetting(siteKey);
      await setJsEnabled(siteKey, !current);
      chrome.tabs.reload(tab.id);
      break;
    }
    case "pick-color":
      await launchTool("color-picker", tab.id, { tab });
      break;
  }
});
