// JSON formatter — runs at document_end on all pages.
// If the page looks like raw JSON (Chrome renders application/json as a single
// <pre> child of <body>), replace it with a styled, collapsible viewer.

(() => {
  if (window.__cb_json_done) return;
  window.__cb_json_done = true;

  chrome.storage.sync.get("global", ({ global }) => {
    if (global && global.jsonFormatterEnabled === false) return;
    tryFormat();
  });

  function tryFormat() {
    const body = document.body;
    if (!body) return;
    if (body.children.length !== 1) return;
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
    body.innerHTML = "";
    body.appendChild(buildToolbar(text, parsed));
    const root = document.createElement("div");
    root.className = "cb-json-tree";
    root.appendChild(render(parsed, ""));
    body.appendChild(root);
  }

  function injectStyles() {
    const s = document.createElement("style");
    s.textContent = `
      html[data-cb-json] body {
        margin: 0;
        background: #0c111d;
        color: #e7eaf3;
        font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .cb-json-toolbar {
        position: sticky;
        top: 0;
        display: flex;
        gap: 8px;
        padding: 8px 16px;
        background: #121829;
        border-bottom: 1px solid #262d44;
        z-index: 10;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
      }
      .cb-json-toolbar button {
        background: #1a2238;
        color: #e7eaf3;
        border: 1px solid #262d44;
        padding: 5px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
      }
      .cb-json-toolbar button:hover { border-color: #38bdf8; color: #38bdf8; }
      .cb-json-toolbar .info { margin-left: auto; color: #98a0b8; align-self: center; }
      .cb-json-tree { padding: 16px 24px 40px; }
      .cb-row { display: block; }
      .cb-key { color: #ec4899; }
      .cb-str { color: #a5e3a8; }
      .cb-num { color: #ffa657; }
      .cb-bool { color: #79c0ff; }
      .cb-null { color: #98a0b8; font-style: italic; }
      .cb-punct { color: #98a0b8; }
      .cb-toggle {
        cursor: pointer;
        user-select: none;
        color: #98a0b8;
        display: inline-block;
        width: 14px;
        text-align: center;
      }
      .cb-toggle:hover { color: #38bdf8; }
      .cb-children { padding-left: 18px; border-left: 1px dashed #232c46; margin-left: 4px; }
      .cb-collapsed > .cb-children { display: none; }
      .cb-collapsed .cb-summary { color: #98a0b8; font-style: italic; }
      .cb-summary { color: #98a0b8; margin-left: 4px; display: none; }
      .cb-collapsed .cb-summary { display: inline; }
    `;
    document.head.appendChild(s);
  }

  function buildToolbar(rawText, parsed) {
    const bar = document.createElement("div");
    bar.className = "cb-json-toolbar";

    const expand = mkBtn("Expand all", () => {
      document.querySelectorAll(".cb-node").forEach((n) =>
        n.classList.remove("cb-collapsed")
      );
    });
    const collapse = mkBtn("Collapse all", () => {
      document.querySelectorAll(".cb-node").forEach((n) =>
        n.classList.add("cb-collapsed")
      );
    });
    const copy = mkBtn("Copy formatted", async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(parsed, null, 2));
        copy.textContent = "Copied!";
        setTimeout(() => (copy.textContent = "Copy formatted"), 1200);
      } catch {
        copy.textContent = "Copy failed";
      }
    });
    const raw = mkBtn("View raw", () => {
      document.body.innerHTML = "";
      document.documentElement.removeAttribute("data-cb-json");
      const pre = document.createElement("pre");
      pre.textContent = rawText;
      document.body.appendChild(pre);
    });

    const info = document.createElement("span");
    info.className = "info";
    info.textContent = `${formatBytes(rawText.length)} · ComboBreaker JSON`;

    bar.append(expand, collapse, copy, raw, info);
    return bar;
  }

  function mkBtn(label, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function formatBytes(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  }

  function render(value, key) {
    const row = document.createElement("div");
    row.className = "cb-row";

    const keyHtml = key !== ""
      ? `<span class="cb-key">"${escapeHtml(key)}"</span><span class="cb-punct">: </span>`
      : "";

    if (value === null) {
      row.innerHTML = keyHtml + `<span class="cb-null">null</span>`;
    } else if (Array.isArray(value)) {
      renderContainer(row, keyHtml, value, "[", "]", true);
    } else if (typeof value === "object") {
      renderContainer(row, keyHtml, value, "{", "}", false);
    } else if (typeof value === "string") {
      row.innerHTML = keyHtml + `<span class="cb-str">"${escapeHtml(value)}"</span>`;
    } else if (typeof value === "number") {
      row.innerHTML = keyHtml + `<span class="cb-num">${value}</span>`;
    } else if (typeof value === "boolean") {
      row.innerHTML = keyHtml + `<span class="cb-bool">${value}</span>`;
    } else {
      row.textContent = String(value);
    }
    return row;
  }

  function renderContainer(row, keyHtml, value, open, close, isArray) {
    const node = document.createElement("div");
    node.className = "cb-node";
    const entries = isArray
      ? value.map((v, i) => [i, v])
      : Object.entries(value);
    const len = entries.length;

    const head = document.createElement("div");
    head.innerHTML =
      `<span class="cb-toggle">▼</span>` +
      keyHtml +
      `<span class="cb-punct">${open}</span>` +
      `<span class="cb-summary">${len} ${isArray ? "item" : "key"}${len === 1 ? "" : "s"}${open === "{" ? "}" : "]"}</span>`;
    node.appendChild(head);

    const children = document.createElement("div");
    children.className = "cb-children";
    entries.forEach(([k, v], i) => {
      const child = render(v, isArray ? "" : String(k));
      if (i < len - 1) child.appendChild(comma());
      children.appendChild(child);
    });
    node.appendChild(children);

    const tail = document.createElement("div");
    tail.innerHTML = `<span class="cb-punct">${close}</span>`;
    node.appendChild(tail);

    head.querySelector(".cb-toggle").addEventListener("click", () => {
      node.classList.toggle("cb-collapsed");
      head.querySelector(".cb-toggle").textContent = node.classList.contains("cb-collapsed") ? "▶" : "▼";
    });

    row.appendChild(node);
  }

  function comma() {
    const c = document.createElement("span");
    c.className = "cb-punct";
    c.textContent = ",";
    return c;
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
