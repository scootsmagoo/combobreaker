// Injected (MAIN world) right after vendor/darkreader.js; undoes dr_amd_guard_on.js.
(() => {
  if (!("__cbAmdMarker" in window)) return;
  try {
    if (typeof window.define === "function") window.define.amd = window.__cbAmdMarker;
  } catch (_) {
    // ignore
  }
  delete window.__cbAmdMarker;
})();
