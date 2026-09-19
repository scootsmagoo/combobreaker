// Tech stack detector: MAIN-world probe + lib/tech.js matching.

import { detectTech, probeInputs } from "../lib/tech.js";
import { getResponseHeaders } from "./net_capture.js";

// ---------- Tech stack detector ----------
//
// The probe runs in the page's MAIN world (framework globals are invisible
// from the isolated world) and only reports which of the names it was handed
// exist; lib/tech.js owns the signature table and does the matching here,
// together with the main document's response headers captured above.

function techProbe(globalPaths, selectorList) {
  const has = (path) => {
    let o = window;
    for (const part of path.split(".")) {
      try {
        if (o == null || !(part in Object(o))) return false;
        o = o[part];
      } catch {
        return false;
      }
    }
    return o != null;
  };
  const str = (f) => {
    try {
      const v = f();
      return typeof v === "string" || typeof v === "number" ? String(v).slice(0, 40) : "";
    } catch {
      return "";
    }
  };
  const out = { globals: globalPaths.filter(has), selectors: [], urls: [], generator: "", flags: {}, versions: {} };
  for (const sel of selectorList) {
    try {
      if (document.querySelector(sel)) out.selectors.push(sel);
    } catch {}
  }
  for (const el of document.querySelectorAll("script[src], link[href]")) {
    if (out.urls.length >= 400) break;
    out.urls.push(String(el.src || el.href).slice(0, 300));
  }
  const gen = document.querySelector('meta[name="generator" i]');
  out.generator = gen ? String(gen.content || "").slice(0, 200) : "";

  // Framework fingerprints that live on DOM nodes rather than on window.
  const roots = [document.body, ...document.querySelectorAll("#root, #app, #__next, main, body > div")].filter(Boolean).slice(0, 40);
  for (const el of roots) {
    for (const k of Object.keys(el)) {
      if (k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$") || k === "_reactRootContainer") out.flags.react = true;
      if (k === "__vue_app__" || k === "__vue__") out.flags.vue = true;
      if (k === "__k" || k === "__P") out.flags.preact = true;
    }
  }
  if (document.querySelector('[class*="svelte-"]')) out.flags.svelte = true;
  // Tailwind leaves no global; its variant prefixes and --tw- variables are distinctive.
  if (document.querySelector('[class*="sm:"], [class*="md:"], [class*="lg:"], [class*="dark:"]')) {
    const probe = document.querySelector('[class*="md:"], [class*="sm:"], [class*="lg:"], [class*="dark:"]');
    const cs = getComputedStyle(probe);
    if (cs.getPropertyValue("--tw-ring-offset-width") || cs.getPropertyValue("--tw-border-style") || cs.getPropertyValue("--tw-shadow")) out.flags.tailwind = true;
  }

  out.versions.react = str(() => window.React.version);
  out.versions.vue = str(() => window.Vue.version) || str(() => document.querySelector("[data-v-app]").__vue_app__.version);
  out.versions.jquery = str(() => window.jQuery.fn.jquery);
  out.versions.next = str(() => window.next.version);
  out.versions.angular = str(() => document.querySelector("[ng-version]").getAttribute("ng-version"));
  return out;
}

export async function detectTechForTab(tabId) {
  if (tabId == null || tabId < 0) return [];
  const { globals, selectors } = probeInputs();
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: techProbe,
    args: [globals, selectors],
  });
  const signals = (res && res.result) || {};
  const captured = await getResponseHeaders(tabId);
  signals.headers = {};
  for (const h of (captured && captured.headers) || []) signals.headers[h.name.toLowerCase()] = h.value;
  return detectTech(signals);
}
