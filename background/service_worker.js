import { originPatternForSite, siteKeyFromUrl } from "../lib/site.js";
import { ensureSchema, getGlobal, getSite, setGlobal, setSite } from "../lib/storage.js";
import {
  adblockMatched,
  applyAdblockState,
  classifyTrackers,
  getCustomBlock,
  setCustomBlock,
  addCustomBlock,
  importCustomBlock,
} from "./blocking.js";
import {
  closeDuplicateTabGroups,
  deleteTabSession,
  extractReaderForTab,
  extractStructuredDataForTab,
  findDuplicateTabGroups,
  linksAction,
  listTabSessions,
  openReaderView,
  openStructuredDataView,
  restoreTabSession,
  saveTabWindowSession,
  setViewportPreset,
} from "./browse.js";
import { applyDarkMode, drFetch, toggleDarkModeGlobal, toggleDarkModeSite } from "./dark_mode.js";
import { applySiteHeaderRules, reapplyAllHeaderRules } from "./header_rules.js";
import { downloadWindowsInstaller } from "./helper_installer.js";
import {
  clearMediaList,
  downloadMedia,
  getMediaList,
  openHelperSetup,
  openHlsDownloader,
  openOptionsSection,
  overlayDownload,
  overlayListAllFrames,
  pushMediaItem,
} from "./media.js";
import { clearRedirectChain, getRedirectChain, getResponseHeaders } from "./net_capture.js";
import { captureFullPage, launchTool, setEncoding } from "./page_tools.js";
import { nukeSiteData, sweepAutoClear } from "./site_data.js";
import { detectTechForTab } from "./tech_detect.js";
import {
  runCodeInTab,
  runUserJsFallback,
  syncUserScripts,
  userScriptsAvailable,
  watchUserScripts,
} from "./user_scripts.js";
import {
  ytdlpCancel,
  ytdlpClearJobs,
  ytdlpDownload,
  ytdlpJobs,
  ytdlpReveal,
  ytdlpStatus,
  ytdlpUpdate,
} from "./ytdlp_bridge.js";

async function boot() {
  await ensureSchema();
  await applyAdblockState();
  await reapplyAllHeaderRules();
  await syncUserScripts();
  await sweepAutoClear();
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
watchUserScripts();

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
    case "set-global":
      return await setGlobal(msg.patch);
    case "apply-dark-mode":
      return await applyDarkMode(sender?.tab?.id, msg.enabled, msg.theme);
    case "cb-dr-fetch":
      return await drFetch(msg.url);
    case "toggle-darkmode-global":
      return await toggleDarkModeGlobal();
    case "toggle-darkmode-site":
      return await toggleDarkModeSite(msg.siteKey);
    case "launch-tool":
      return await launchTool(msg.tool, msg.tabId, sender);
    case "capture-fullpage":
      return await captureFullPage(msg.tabId);
    case "set-encoding":
      return await setEncoding(msg.tabId, msg.encoding);
    case "apply-adblock":
      return await applyAdblockState();
    case "classify-trackers":
      return await classifyTrackers(msg.hosts, sender?.tab?.url);
    case "custom-block-get":
      return { hosts: await getCustomBlock() };
    case "custom-block-set":
      return await setCustomBlock(msg.hosts);
    case "custom-block-import":
      return await importCustomBlock(msg.text);
    case "custom-block-add":
      return await addCustomBlock(msg.host, sender?.tab?.url);
    case "adblock-matched":
      return await adblockMatched(msg.tabId);
    case "get-redirect-chain":
      return await getRedirectChain(msg.tabId);
    case "clear-redirect-chain":
      return await clearRedirectChain(msg.tabId);
    case "get-response-headers":
      return await getResponseHeaders(msg.tabId);
    case "apply-site-headers":
      return await applySiteHeaderRules(msg.siteKey);
    case "media-found":
      return await pushMediaItem(sender?.tab?.id, msg.item);
    case "media-list":
      return await getMediaList(msg.tabId);
    case "media-clear":
      return await clearMediaList(msg.tabId);
    case "media-download":
      return await downloadMedia(msg.url, msg.filename);
    case "media-list-mine":
      return await getMediaList(sender?.tab?.id);
    case "open-hls-downloader":
      return await openHlsDownloader(msg.url, msg.title, msg.referer);
    case "overlay-download":
      return await overlayDownload(msg, sender);
    case "ytdlp-status":
      return await ytdlpStatus(!!msg.force);
    case "ytdlp-download":
      return await ytdlpDownload({
        url: msg.url,
        quality: msg.quality,
        title: msg.title,
        tabId: msg.tabId != null ? msg.tabId : sender?.tab?.id,
        itemId: msg.itemId,
        page: msg.page,
        referer: msg.referer,
        thumb: msg.thumb,
        site: msg.site,
      });
    case "ytdlp-cancel":
      return await ytdlpCancel(msg.jobId);
    case "ytdlp-reveal":
      return await ytdlpReveal(msg.path);
    case "ytdlp-jobs":
      return await ytdlpJobs();
    case "ytdlp-clear-jobs":
      return await ytdlpClearJobs();
    case "run-snippet":
      return await runCodeInTab(msg.tabId, msg.code);
    case "apply-auto-clear":
      return await sweepAutoClear();
    case "detect-tech":
      return await detectTechForTab(msg.tabId);
    case "nuke-site-data":
      return await nukeSiteData(msg.siteKey, msg.tabUrl);
    case "run-user-js":
      return await runUserJsFallback(sender);
    case "userscripts-status":
      // Also re-syncs, so flipping "Allow User Scripts" takes effect as soon
      // as the options page is opened.
      return { ...(await syncUserScripts()), available: userScriptsAvailable() };
    case "ytdlp-update":
      return await ytdlpUpdate();
    case "open-helper-setup":
      return await openHelperSetup();
    case "helper-installer-download":
      return await downloadWindowsInstaller();
    case "open-options":
      return await openOptionsSection(msg.section);
    case "overlay-list-all":
      return await overlayListAllFrames(msg.tabId);
    case "reader-extract":
      return await extractReaderForTab(msg.tabId);
    case "reader-open":
      return await openReaderView(msg.tabId);
    case "structured-data-extract":
      return await extractStructuredDataForTab(msg.tabId);
    case "structured-data-open":
      return await openStructuredDataView(msg.tabId);
    case "set-viewport-preset":
      return await setViewportPreset(msg.tabId, msg.preset, msg.siteKey);
    case "list-tab-sessions":
      return await listTabSessions();
    case "save-tab-session":
      return await saveTabWindowSession(msg.name);
    case "delete-tab-session":
      return await deleteTabSession(msg.sessionId);
    case "restore-tab-session":
      return await restoreTabSession(msg.sessionId);
    case "links-action":
      return await linksAction(msg, sender);
    case "find-duplicate-tabs":
      return findDuplicateTabGroups();
    case "close-duplicate-tabs":
      return await closeDuplicateTabGroups();
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

// ---------- Keyboard commands ----------

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === "select-links") {
    // No answer = the tab predates the extension or is a page Chrome keeps us out of.
    chrome.tabs.sendMessage(tab.id, { type: "cb-link-select-arm" }, { frameId: 0 }).catch(() => {});
    return;
  }
  const siteKey = siteKeyFromUrl(tab.url);
  if (!siteKey) return;

  switch (command) {
    case "toggle-darkmode":
      await toggleDarkModeSite(siteKey);
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
    // Ships without a key: it is destructive and asks nothing, so it only
    // exists for people who bind it at chrome://extensions/shortcuts.
    case "nuke-site-data":
      await nukeSiteData(siteKey, tab.url);
      chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "Site data cleared",
        message: `Cookies, storage, caches and service workers for ${siteKey} are gone. Reloading the tab.`,
      });
      chrome.tabs.reload(tab.id);
      break;
  }
});
