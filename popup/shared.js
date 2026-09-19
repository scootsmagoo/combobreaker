// Shared by popup.js and the pane modules: the popup's one bit of state, DOM
// and messaging helpers, and the status line.

export const $ = (id) => document.getElementById(id);

export const STATE = {
  tab: null,
  siteKey: null,
  settings: null,
  global: null,
  jsEnabled: true,
  activeTab: "site",
};

export function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error("no response from service worker"));
      if (!resp.ok) return reject(new Error(resp.error || "unknown error"));
      resolve(resp.result);
    });
  });
}

export function status(text, kind) {
  const el = $("status");
  el.hidden = false;
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function badge(text, cls = "") {
  const b = document.createElement("span");
  b.className = "badge" + (cls ? " " + cls : "");
  b.textContent = text;
  return b;
}
