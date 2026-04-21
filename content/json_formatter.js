// JSON formatter — runs at document_end on all pages.
//
// If the page looks like raw JSON (Chrome renders application/json as a single
// <pre> child of <body>), we replace it with an interactive viewer:
//   - Three view modes: Tree, Formatted (pretty-printed text), Raw
//   - Level buttons (1, 2, 3, 4, 5, All) to expand/collapse to depth
//   - Hover any row to see its JSON path; click to pin & copy
//   - Per-node "expand all descendants" inline button
//   - Theme cycle: Auto (system) / Dark / Light  (persisted)
//   - window.data is exposed in the page console for ad-hoc inspection
//
// Feature set inspired by JSON Alexander (https://github.com/wesbos/JSON-Alexander, MIT).
// All code below is original to ComboBreaker.

(() => {
  if (window.__cb_json_done) return;
  window.__cb_json_done = true;

  const PREFS_KEY = "json_formatter_prefs";
  const DEFAULT_PREFS = { theme: "auto", view: "tree", level: null };

  chrome.storage.sync.get(["global", PREFS_KEY], (data) => {
    if (data.global && data.global.jsonFormatterEnabled === false) return;
    const prefs = { ...DEFAULT_PREFS, ...(data[PREFS_KEY] || {}) };
    tryFormat(prefs);
  });

  function savePrefs(patch) {
    chrome.storage.sync.get(PREFS_KEY, (data) => {
      const merged = { ...DEFAULT_PREFS, ...(data[PREFS_KEY] || {}), ...patch };
      chrome.storage.sync.set({ [PREFS_KEY]: merged });
    });
  }

  function tryFormat(prefs) {
    const body = document.body;
    if (!body || body.children.length !== 1) return;
    const pre = body.children[0];
    if (pre.tagName !== "PRE") return;
    const text = pre.textContent.trim();
    if (text.length < 2) return;
    const first = text[0];
    const last = text[text.length - 1];
    if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    document.documentElement.setAttribute("data-cb-json", "1");
    injectStyles();
    applyTheme(prefs.theme);
    body.innerHTML = "";

    const state = {
      parsed,
      rawText: text,
      view: prefs.view || "tree",
      level: prefs.level,
      theme: prefs.theme,
      pinnedPath: null,
      hoverPath: null,
    };

    const toolbar = buildToolbar(state);
    const pathBar = buildPathBar(state);
    body.appendChild(toolbar);
    body.appendChild(pathBar);

    const main = document.createElement("main");
    main.id = "cb-json-main";
    body.appendChild(main);

    state.main = main;
    state.toolbar = toolbar;
    state.pathBar = pathBar;

    renderActiveView(state);
    exposeWindowData(parsed);

    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", () => {
          if (state.theme === "auto") applyTheme("auto");
        });
    }
  }

  // ---------- Theme ----------

  function applyTheme(theme) {
    const root = document.documentElement;
    let resolved = theme;
    if (theme === "auto") {
      resolved = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    root.setAttribute("data-cb-theme", resolved);
  }

  function cycleTheme(state, btn) {
    const order = ["auto", "dark", "light"];
    const next = order[(order.indexOf(state.theme) + 1) % order.length];
    state.theme = next;
    applyTheme(next);
    savePrefs({ theme: next });
    btn.textContent = themeLabel(next);
  }

  function themeLabel(t) {
    return t === "auto" ? "Theme: Auto" : t === "dark" ? "Theme: Dark" : "Theme: Light";
  }

  // ---------- Toolbar ----------

  function buildToolbar(state) {
    const bar = document.createElement("header");
    bar.className = "cb-toolbar";

    const viewGroup = document.createElement("div");
    viewGroup.className = "cb-group";
    for (const v of ["tree", "formatted", "raw"]) {
      const b = mkBtn(cap(v), () => switchView(state, v));
      b.dataset.view = v;
      if (v === state.view) b.classList.add("active");
      viewGroup.appendChild(b);
    }
    bar.appendChild(viewGroup);

    const levelGroup = document.createElement("div");
    levelGroup.className = "cb-group cb-levels";
    const levelLabel = document.createElement("span");
    levelLabel.className = "cb-label";
    levelLabel.textContent = "Level";
    levelGroup.appendChild(levelLabel);
    for (const n of [1, 2, 3, 4, 5]) {
      const b = mkBtn(String(n), () => setLevel(state, n));
      b.dataset.level = String(n);
      levelGroup.appendChild(b);
    }
    const allBtn = mkBtn("All", () => setLevel(state, null));
    allBtn.dataset.level = "all";
    if (state.level == null) allBtn.classList.add("active");
    levelGroup.appendChild(allBtn);
    bar.appendChild(levelGroup);

    const right = document.createElement("div");
    right.className = "cb-group cb-right";

    const themeBtn = mkBtn(themeLabel(state.theme), () => cycleTheme(state, themeBtn));
    right.appendChild(themeBtn);

    const copyBtn = mkBtn("Copy JSON", async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(state.parsed, null, 2));
        flashBtn(copyBtn, "Copied!");
      } catch {
        flashBtn(copyBtn, "Copy failed", true);
      }
    });
    right.appendChild(copyBtn);

    const info = document.createElement("span");
    info.className = "cb-info";
    info.textContent = `${formatBytes(state.rawText.length)} · ComboBreaker`;
    right.appendChild(info);

    bar.appendChild(right);
    return bar;
  }

  function buildPathBar(state) {
    const bar = document.createElement("div");
    bar.className = "cb-pathbar";

    const label = document.createElement("span");
    label.className = "cb-path-label";
    label.textContent = "path";
    bar.appendChild(label);

    const path = document.createElement("code");
    path.className = "cb-path";
    path.textContent = "data";
    bar.appendChild(path);

    const pin = document.createElement("button");
    pin.className = "cb-path-pin";
    pin.textContent = "📌";
    pin.title = "Toggle pin";
    pin.addEventListener("click", () => {
      if (state.pinnedPath) {
        state.pinnedPath = null;
        bar.classList.remove("pinned");
      } else {
        state.pinnedPath = path.textContent;
        bar.classList.add("pinned");
      }
    });
    bar.appendChild(pin);

    const copy = document.createElement("button");
    copy.className = "cb-path-copy";
    copy.textContent = "Copy path";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(path.textContent);
        flashBtn(copy, "Copied!");
      } catch {
        flashBtn(copy, "Failed", true);
      }
    });
    bar.appendChild(copy);

    state._setPathDisplay = (p) => {
      if (state.pinnedPath) return;
      path.textContent = p || "data";
    };
    state._getPathEl = () => path;
    return bar;
  }

  function mkBtn(label, onClick) {
    const b = document.createElement("button");
    b.className = "cb-btn";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function flashBtn(btn, text, isErr) {
    const original = btn.textContent;
    btn.textContent = text;
    if (isErr) btn.classList.add("err");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("err");
    }, 1200);
  }

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function formatBytes(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  }

  // ---------- View switching ----------

  function switchView(state, view) {
    state.view = view;
    savePrefs({ view });
    state.toolbar
      .querySelectorAll(".cb-group:first-child .cb-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    renderActiveView(state);
  }

  function setLevel(state, level) {
    state.level = level;
    savePrefs({ level });
    state.toolbar
      .querySelectorAll(".cb-levels .cb-btn")
      .forEach((b) => {
        const want = level == null ? "all" : String(level);
        b.classList.toggle("active", b.dataset.level === want);
      });
    if (state.view === "tree") applyLevel(state);
  }

  function renderActiveView(state) {
    state.main.innerHTML = "";
    if (state.view === "tree") {
      state.main.appendChild(renderTree(state));
      applyLevel(state);
    } else if (state.view === "formatted") {
      state.main.appendChild(renderFormatted(state));
    } else {
      state.main.appendChild(renderRaw(state));
    }
  }

  function applyLevel(state) {
    if (state.level == null) {
      state.main
        .querySelectorAll(".cb-node.cb-collapsed")
        .forEach((n) => setCollapsed(n, false));
      return;
    }
    state.main.querySelectorAll(".cb-node").forEach((n) => {
      const depth = Number(n.dataset.depth || 0);
      setCollapsed(n, depth >= state.level);
    });
  }

  function setCollapsed(node, collapsed) {
    node.classList.toggle("cb-collapsed", collapsed);
    const tog = node.querySelector(":scope > .cb-row > .cb-toggle");
    if (tog) tog.textContent = collapsed ? "▶" : "▼";
  }

  // ---------- Tree view ----------

  function renderTree(state) {
    const wrap = document.createElement("div");
    wrap.className = "cb-tree";
    wrap.appendChild(renderNode(state.parsed, "", "data", 0, state, true));

    wrap.addEventListener("mousemove", (e) => {
      const row = e.target.closest("[data-path]");
      if (!row) return;
      state._setPathDisplay(row.dataset.path);
    });
    wrap.addEventListener("click", (e) => {
      const tog = e.target.closest(".cb-toggle");
      if (tog) {
        const node = tog.closest(".cb-node");
        if (node) setCollapsed(node, !node.classList.contains("cb-collapsed"));
        e.stopPropagation();
        return;
      }
      const exp = e.target.closest(".cb-expand-all");
      if (exp) {
        const node = exp.closest(".cb-node");
        if (node) {
          node.classList.remove("cb-collapsed");
          node.querySelectorAll(".cb-node").forEach((n) => setCollapsed(n, false));
          setCollapsed(node, false);
        }
        e.stopPropagation();
        return;
      }
      const row = e.target.closest("[data-path]");
      if (!row) return;
      const path = row.dataset.path;
      state.pinnedPath = path;
      state._getPathEl().textContent = path;
      state.pathBar.classList.add("pinned");
    });
    return wrap;
  }

  function renderNode(value, key, path, depth, state, isRoot) {
    const isObj = value !== null && typeof value === "object";
    const isArr = Array.isArray(value);

    if (!isObj) {
      const row = document.createElement("div");
      row.className = "cb-row";
      row.dataset.path = path;
      row.dataset.depth = depth;
      row.appendChild(makeKey(key, isRoot));
      row.appendChild(makeValue(value));
      return row;
    }

    const node = document.createElement("div");
    node.className = "cb-node";
    node.dataset.depth = depth;

    const head = document.createElement("div");
    head.className = "cb-row";
    head.dataset.path = path;
    head.dataset.depth = depth;
    head.appendChild(toggleEl());
    head.appendChild(expandAllEl());
    head.appendChild(makeKey(key, isRoot));
    const open = document.createElement("span");
    open.className = "cb-punct";
    open.textContent = isArr ? "[" : "{";
    head.appendChild(open);
    head.appendChild(summary(value, isArr));
    node.appendChild(head);

    const children = document.createElement("div");
    children.className = "cb-children";
    const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
    entries.forEach(([k, v], i) => {
      const childPath = isArr
        ? `${path}[${k}]`
        : isIdent(String(k))
          ? `${path}.${k}`
          : `${path}[${JSON.stringify(String(k))}]`;
      const child = renderNode(v, isArr ? "" : String(k), childPath, depth + 1, state, false);
      if (i < entries.length - 1) {
        const last = lastRow(child);
        if (last) last.appendChild(comma());
      }
      children.appendChild(child);
    });
    node.appendChild(children);

    const tail = document.createElement("div");
    tail.className = "cb-row cb-tail";
    tail.dataset.path = path;
    tail.dataset.depth = depth;
    const close = document.createElement("span");
    close.className = "cb-punct";
    close.textContent = isArr ? "]" : "}";
    tail.appendChild(close);
    node.appendChild(tail);

    return node;
  }

  function lastRow(child) {
    if (child.classList.contains("cb-row")) return child;
    return child.querySelector(":scope > .cb-tail");
  }

  function toggleEl() {
    const t = document.createElement("span");
    t.className = "cb-toggle";
    t.textContent = "▼";
    t.title = "Collapse / expand";
    return t;
  }

  function expandAllEl() {
    const e = document.createElement("span");
    e.className = "cb-expand-all";
    e.textContent = "⤓";
    e.title = "Expand all descendants";
    return e;
  }

  function makeKey(key, isRoot) {
    const span = document.createElement("span");
    if (isRoot) {
      span.className = "cb-root-key";
      span.textContent = "";
      return span;
    }
    if (key === "") {
      span.style.display = "none";
      return span;
    }
    span.innerHTML =
      `<span class="cb-key">"${escapeHtml(String(key))}"</span><span class="cb-punct">: </span>`;
    return span;
  }

  function makeValue(v) {
    const span = document.createElement("span");
    if (v === null) {
      span.innerHTML = `<span class="cb-null">null</span>`;
    } else if (typeof v === "string") {
      span.innerHTML = `<span class="cb-str">"${escapeHtml(v)}"</span>`;
    } else if (typeof v === "number") {
      span.innerHTML = `<span class="cb-num">${v}</span>`;
    } else if (typeof v === "boolean") {
      span.innerHTML = `<span class="cb-bool">${v}</span>`;
    } else {
      span.textContent = String(v);
    }
    return span;
  }

  function summary(value, isArr) {
    const len = isArr ? value.length : Object.keys(value).length;
    const s = document.createElement("span");
    s.className = "cb-summary";
    s.textContent = ` ${len} ${isArr ? "item" : "key"}${len === 1 ? "" : "s"} ${isArr ? "]" : "}"}`;
    return s;
  }

  function comma() {
    const c = document.createElement("span");
    c.className = "cb-punct";
    c.textContent = ",";
    return c;
  }

  function isIdent(s) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
  }

  // ---------- Formatted (pretty-printed text, syntax-highlighted) ----------

  function renderFormatted(state) {
    const pre = document.createElement("pre");
    pre.className = "cb-formatted";
    pre.innerHTML = highlightFormatted(state.parsed);
    return pre;
  }

  function highlightFormatted(value) {
    const text = JSON.stringify(value, null, 2);
    return text.replace(
      /("(?:\\.|[^"\\])*")(\s*:)?|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
      (match, str, colon, kw, num) => {
        if (str) {
          if (colon) return `<span class="cb-key">${escapeHtml(str)}</span>${escapeHtml(colon)}`;
          return `<span class="cb-str">${escapeHtml(str)}</span>`;
        }
        if (kw) {
          const cls = kw === "null" ? "cb-null" : "cb-bool";
          return `<span class="${cls}">${kw}</span>`;
        }
        if (num) return `<span class="cb-num">${num}</span>`;
        return match;
      }
    );
  }

  // ---------- Raw ----------

  function renderRaw(state) {
    const pre = document.createElement("pre");
    pre.className = "cb-raw";
    pre.textContent = state.rawText;
    return pre;
  }

  // ---------- window.data exposure ----------
  // Inject a script tag (page world) that sets window.data.

  function exposeWindowData(parsed) {
    try {
      const safe = JSON.stringify(parsed).replace(/<\/script/gi, "<\\/script");
      const script = document.createElement("script");
      script.textContent = `try{window.data=${safe};}catch(e){}`;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch (e) {
      console.warn("[ComboBreaker] couldn't expose window.data:", e);
    }
  }

  // ---------- Styles ----------

  function injectStyles() {
    const s = document.createElement("style");
    s.textContent = `
      html[data-cb-json][data-cb-theme="dark"] {
        --cb-bg: #0c111d;
        --cb-bg-2: #121829;
        --cb-bg-3: #1a2238;
        --cb-fg: #e7eaf3;
        --cb-fg-dim: #98a0b8;
        --cb-border: #262d44;
        --cb-accent: #38bdf8;
        --cb-accent-2: #ec4899;
        --cb-key: #ec4899;
        --cb-str: #a5e3a8;
        --cb-num: #ffa657;
        --cb-bool: #79c0ff;
        --cb-null: #98a0b8;
        --cb-punct: #98a0b8;
        --cb-guide: #232c46;
        --cb-guide-hover: #38bdf8;
      }
      html[data-cb-json][data-cb-theme="light"] {
        --cb-bg: #fafafa;
        --cb-bg-2: #f0f1f5;
        --cb-bg-3: #e6e8ee;
        --cb-fg: #1a1f2e;
        --cb-fg-dim: #6b7280;
        --cb-border: #d1d5db;
        --cb-accent: #0284c7;
        --cb-accent-2: #be185d;
        --cb-key: #be185d;
        --cb-str: #15803d;
        --cb-num: #b45309;
        --cb-bool: #1d4ed8;
        --cb-null: #6b7280;
        --cb-punct: #6b7280;
        --cb-guide: #d1d5db;
        --cb-guide-hover: #0284c7;
      }
      html[data-cb-json] body {
        margin: 0;
        background: var(--cb-bg);
        color: var(--cb-fg);
        font: 13px/1.55 ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, monospace;
      }
      .cb-toolbar {
        position: sticky;
        top: 0;
        z-index: 20;
        display: flex;
        gap: 12px;
        align-items: center;
        padding: 8px 16px;
        background: var(--cb-bg-2);
        border-bottom: 1px solid var(--cb-border);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        flex-wrap: wrap;
      }
      .cb-group { display: flex; gap: 4px; align-items: center; }
      .cb-right { margin-left: auto; }
      .cb-label {
        color: var(--cb-fg-dim);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        margin-right: 4px;
      }
      .cb-btn {
        background: var(--cb-bg-3);
        color: var(--cb-fg);
        border: 1px solid var(--cb-border);
        padding: 5px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-family: inherit;
        line-height: 1.2;
      }
      .cb-btn:hover {
        border-color: var(--cb-accent);
        color: var(--cb-accent);
      }
      .cb-btn.active {
        background: var(--cb-accent);
        color: var(--cb-bg);
        border-color: var(--cb-accent);
        font-weight: 600;
      }
      .cb-btn.err { border-color: #ef4444; color: #ef4444; }
      .cb-info {
        margin-left: 8px;
        color: var(--cb-fg-dim);
        font-size: 11px;
      }

      .cb-pathbar {
        position: sticky;
        top: 41px;
        z-index: 19;
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 6px 16px;
        background: var(--cb-bg);
        border-bottom: 1px solid var(--cb-border);
        font-size: 12px;
      }
      .cb-pathbar.pinned { background: var(--cb-bg-2); border-bottom-color: var(--cb-accent-2); }
      .cb-path-label {
        color: var(--cb-fg-dim);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.6px;
      }
      .cb-path {
        color: var(--cb-accent);
        font-family: ui-monospace, monospace;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        background: transparent;
        padding: 2px 0;
      }
      .cb-pathbar.pinned .cb-path { color: var(--cb-accent-2); }
      .cb-path-pin, .cb-path-copy {
        background: transparent;
        color: var(--cb-fg-dim);
        border: 1px solid var(--cb-border);
        padding: 3px 8px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
        font-family: inherit;
      }
      .cb-path-pin:hover, .cb-path-copy:hover { color: var(--cb-accent); border-color: var(--cb-accent); }
      .cb-pathbar.pinned .cb-path-pin { color: var(--cb-accent-2); border-color: var(--cb-accent-2); }

      #cb-json-main {
        padding: 16px 24px 60px;
      }

      .cb-tree { line-height: 1.6; }
      .cb-row {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        padding: 1px 4px;
        border-radius: 3px;
        cursor: pointer;
        position: relative;
      }
      .cb-row:hover { background: var(--cb-bg-2); }
      .cb-tail { padding-left: 4px; }

      .cb-key { color: var(--cb-key); }
      .cb-str { color: var(--cb-str); word-break: break-word; }
      .cb-num { color: var(--cb-num); }
      .cb-bool { color: var(--cb-bool); }
      .cb-null { color: var(--cb-null); font-style: italic; }
      .cb-punct { color: var(--cb-punct); }
      .cb-summary {
        color: var(--cb-fg-dim);
        margin-left: 6px;
        font-style: italic;
        display: none;
      }

      .cb-toggle {
        cursor: pointer;
        user-select: none;
        color: var(--cb-fg-dim);
        display: inline-block;
        width: 14px;
        text-align: center;
        font-size: 10px;
        margin-right: 2px;
      }
      .cb-toggle:hover { color: var(--cb-accent); }
      .cb-expand-all {
        cursor: pointer;
        color: var(--cb-fg-dim);
        font-size: 11px;
        margin-right: 4px;
        opacity: 0;
        transition: opacity 0.1s ease;
        user-select: none;
      }
      .cb-row:hover .cb-expand-all { opacity: 1; }
      .cb-expand-all:hover { color: var(--cb-accent); }

      .cb-children {
        padding-left: 18px;
        border-left: 1px solid var(--cb-guide);
        margin-left: 6px;
        transition: border-color 0.1s ease;
      }
      .cb-children:hover { border-left-color: var(--cb-guide-hover); }

      .cb-node.cb-collapsed > .cb-children { display: none; }
      .cb-node.cb-collapsed > .cb-tail { display: none; }
      .cb-node.cb-collapsed > .cb-row .cb-summary { display: inline; }
      .cb-node.cb-collapsed > .cb-row .cb-punct:first-of-type { display: none; }

      .cb-formatted, .cb-raw {
        margin: 0;
        padding: 16px 24px 60px;
        background: var(--cb-bg);
        color: var(--cb-fg);
        font: 13px/1.55 ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, monospace;
        white-space: pre;
        overflow-x: auto;
      }
    `;
    document.head.appendChild(s);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }
})();
