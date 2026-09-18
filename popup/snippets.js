// Snippets: named JS blobs you run on the current tab on demand (the
// bookmarklet use case). Per-site Custom JS is "always run here"; this is
// "run this now". Stored in chrome.storage.local under cb_snippets and
// included in Backup → Export.
//
// Snippet = { id: string, name: string, code: string, updated: number }

const KEY = "cb_snippets";

const STARTERS = [
  {
    name: "Table → CSV (first table)",
    code: `const t = document.querySelector("table");
if (!t) { alert("No <table> on this page"); }
else {
  const csv = [...t.rows].map(r => [...r.cells].map(c => '"' + c.innerText.trim().replace(/"/g, '""') + '"').join(",")).join("\\n");
  navigator.clipboard.writeText(csv).then(() => alert("Copied " + t.rows.length + " rows as CSV"));
}`,
  },
  {
    name: "Unstick fixed headers / overlays",
    code: `for (const el of document.querySelectorAll("body *")) {
  const p = getComputedStyle(el).position;
  if (p === "fixed" || p === "sticky") el.remove();
}
document.documentElement.style.overflow = document.body.style.overflow = "auto";`,
  },
  {
    name: "Enable text selection + right-click",
    code: `const s = document.createElement("style");
s.textContent = "*{user-select:text!important;-webkit-user-select:text!important}";
document.head.appendChild(s);
for (const ev of ["contextmenu", "copy", "cut", "paste", "selectstart"]) {
  document.addEventListener(ev, e => e.stopImmediatePropagation(), true);
}`,
  },
];

export async function loadSnippets() {
  const data = await chrome.storage.local.get(KEY);
  return Array.isArray(data[KEY]) ? data[KEY] : null;
}

async function saveSnippets(list) {
  await chrome.storage.local.set({ [KEY]: list });
}

function newId() {
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function initSnippets({ tab, status, sendMessage }) {
  const $ = (id) => document.getElementById(id);
  const root = document.querySelector('.util[data-util="snippets"]');
  if (!root) return;

  let list = [];
  let editingId = null;

  async function refresh() {
    const stored = await loadSnippets();
    // First run: seed a few useful ones so the feature explains itself.
    list = stored || STARTERS.map((s) => ({ ...s, id: newId(), updated: Date.now() }));
    if (!stored) await saveSnippets(list);
    render();
  }

  function render() {
    const ul = $("snip-list");
    ul.textContent = "";
    if (!list.length) {
      const li = document.createElement("li");
      li.className = "empty muted";
      li.textContent = "No snippets yet.";
      ul.appendChild(li);
      return;
    }
    for (const s of list) {
      const li = document.createElement("li");
      li.className = "snip-item";
      const name = document.createElement("span");
      name.className = "snip-name";
      name.textContent = s.name;
      name.title = s.code.slice(0, 400);
      const actions = document.createElement("span");
      actions.className = "snip-actions";
      actions.append(
        btn("Run", "ghost-btn snip-run", () => run(s)),
        btn("Edit", "ghost-btn", () => edit(s)),
        btn("✕", "danger-btn", () => remove(s))
      );
      li.append(name, actions);
      ul.appendChild(li);
    }
  }

  function btn(text, cls, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  async function run(s) {
    if (!tab || tab.id == null) return status("No active tab", "err");
    try {
      const res = await sendMessage({ type: "run-snippet", tabId: tab.id, code: s.code });
      status(`Ran "${s.name}"${res && res.via === "scripting" ? " (page CSP may block it — enable Allow User Scripts)" : ""}`, "ok");
    } catch (e) {
      status(String(e.message || e), "err");
    }
  }

  function edit(s) {
    editingId = s ? s.id : null;
    $("snip-name").value = s ? s.name : "";
    $("snip-code").value = s ? s.code : "";
    $("snip-editor").hidden = false;
    $("snip-name").focus();
  }

  async function remove(s) {
    if (!confirm(`Delete snippet "${s.name}"?`)) return;
    list = list.filter((x) => x.id !== s.id);
    await saveSnippets(list);
    render();
  }

  $("snip-new").addEventListener("click", () => edit(null));
  $("snip-cancel").addEventListener("click", () => ($("snip-editor").hidden = true));
  $("snip-save").addEventListener("click", async () => {
    const name = $("snip-name").value.trim();
    const code = $("snip-code").value;
    if (!name || !code.trim()) return status("Snippet needs a name and some code", "err");
    const existing = list.find((x) => x.id === editingId);
    if (existing) Object.assign(existing, { name, code, updated: Date.now() });
    else list.push({ id: newId(), name, code, updated: Date.now() });
    list.sort((a, b) => a.name.localeCompare(b.name));
    await saveSnippets(list);
    $("snip-editor").hidden = true;
    render();
    status("Snippet saved", "ok");
  });

  // Lazy: only hit storage when the section is first opened.
  root.addEventListener("toggle", () => root.open && !list.length && refresh(), { once: false });
}
