import js from "@eslint/js";
import globals from "globals";

const chrome = { chrome: "readonly" };

export default [
  { ignores: ["vendor/**", "node_modules/**", "dist/**", "_metadata/**", "scripts/.smoke-out/**"] },
  js.configs.recommended,
  {
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["background/**", "lib/**", "popup/**", "options/**", "viewer/**"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.browser, ...globals.serviceworker, ...chrome },
    },
  },
  {
    files: ["content/**", "tools/**"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, ...chrome } },
  },
  {
    // Runs after the vendored UMD bundles, which define these.
    files: ["content/reader_inject.js"],
    languageOptions: { globals: { module: "writable", Readability: "readonly", TurndownService: "readonly" } },
  },
  {
    files: ["scripts/**", "native/**", "**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
  },
  {
    // page.evaluate() callbacks run in the browser.
    files: ["scripts/smoke_*.js", "scripts/store_screenshots.js", "scripts/store_promo.js"],
    languageOptions: { globals: { ...globals.browser, ...chrome } },
  },
  {
    files: ["test/**", "**/*.mjs"],
    languageOptions: { sourceType: "module", globals: { ...globals.node } },
  },
];
