// Per-tab network capture: redirect chain and main-document response headers.

// ---------- Redirect tracer ----------
// We log main_frame redirects per tab to chrome.storage.session so the chain
// survives service-worker sleeps. Each entry is one of:
//   { type: "start",    url, time }
//   { type: "redirect", from, to, status, time }
//   { type: "end",      url, status, time }
//
// A new "start" entry resets the chain for that tab.

const REDIRECT_KEY = (tabId) => `redirects:${tabId}`;
const MAX_CHAIN = 50;

// onBeforeRequest fires again for every hop of a redirect (same requestId), so
// only a "start" with a new requestId begins a new chain. Writes are queued
// per tab: the events arrive faster than storage round-trips.
const redirectQueues = new Map();

function pushRedirect(tabId, entry) {
  if (tabId < 0) return;
  const prev = redirectQueues.get(tabId) || Promise.resolve();
  const next = prev.then(() => pushRedirectNow(tabId, entry)).catch(() => {});
  redirectQueues.set(tabId, next);
  next.then(() => {
    if (redirectQueues.get(tabId) === next) redirectQueues.delete(tabId);
  });
}

async function pushRedirectNow(tabId, entry) {
  const key = REDIRECT_KEY(tabId);
  const data = await chrome.storage.session.get(key);
  let chain = data[key] || [];
  if (entry.type === "start") {
    if (chain.length && chain[0].requestId === entry.requestId) return;
    chain = [];
  }
  chain.push(entry);
  if (chain.length > MAX_CHAIN) chain = chain.slice(-MAX_CHAIN);
  await chrome.storage.session.set({ [key]: chain });
}

export async function getRedirectChain(tabId) {
  if (tabId == null || tabId < 0) return [];
  const key = REDIRECT_KEY(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] || [];
}

export async function clearRedirectChain(tabId) {
  if (tabId == null || tabId < 0) return;
  await chrome.storage.session.remove(REDIRECT_KEY(tabId));
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    pushRedirect(details.tabId, {
      type: "start",
      requestId: details.requestId,
      url: details.url,
      time: Date.now(),
    });
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    pushRedirect(details.tabId, {
      type: "redirect",
      from: details.url,
      to: details.redirectUrl,
      status: details.statusCode,
      time: Date.now(),
    });
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    pushRedirect(details.tabId, {
      type: "end",
      url: details.url,
      status: details.statusCode,
      time: Date.now(),
    });
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(REDIRECT_KEY(tabId)).catch(() => {});
});

// ---------- Response-header capture (per tab) ----------
// Mirrors the redirect tracer: main_frame only, kept in chrome.storage.session
// so the data survives SW sleeps. We store the *latest* main_frame response
// (chain end), not every request — the popup is for "what's the current page".

const HEADERS_KEY = (tabId) => `headers:${tabId}`;

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    const entry = {
      url: details.url,
      status: details.statusCode,
      time: Date.now(),
      headers: (details.responseHeaders || []).map((h) => ({
        name: h.name,
        value: h.value ?? (h.binaryValue ? "(binary)" : ""),
      })),
    };
    chrome.storage.session
      .set({ [HEADERS_KEY(details.tabId)]: entry })
      .catch(() => {});
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders"]
);

export async function getResponseHeaders(tabId) {
  if (tabId == null || tabId < 0) return null;
  const key = HEADERS_KEY(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(HEADERS_KEY(tabId)).catch(() => {});
});
