// Injected (MAIN world) right before vendor/darkreader.js. Dark Reader's UMD
// wrapper registers itself through define() when the page has an AMD loader
// (RequireJS on bbc.com, for one) and then never creates window.DarkReader.
// Hiding just the `amd` marker for the duration of the injection makes the
// wrapper take its plain-global branch; the page's own define() keeps working.
(() => {
  const d = window.define;
  if (typeof d !== "function" || !d.amd) return;
  window.__cbAmdMarker = d.amd;
  try {
    d.amd = undefined;
  } catch (_) {
    // non-writable: nothing to be done, Dark Reader will go the AMD way
  }
})();
