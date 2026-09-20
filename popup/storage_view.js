// localStorage / sessionStorage viewer for the Cookies tab, plus the names of
// the page's IndexedDB databases and Cache Storage caches. Everything runs as
// small chrome.scripting functions in the tab's top frame (the isolated world
// shares the page's storage), so what you see is what the page sees.

const MAX_VALUE = 50_000; // longer values are shown clipped and can't be edited

let CTX = null; // { tab, siteKey, status }
let KIND = "cookies"; // "cookies" | "local" | "session"

const $ = (id) => document.getElementById(id);

// ---- injected into the page (must be self-contained) ----

function pageRead(kind, maxValue) {
  const store = kind === "session" ? sessionStorage : localStorage;
  const entries = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    const value = store.getItem(key) ?? "";
    entries.push({ key, size: value.length, clipped: value.length > maxValue, value: value.slice(0, maxValue) });
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  const names = (p) => p.then((v) => v, () => []);
  return Promise.all([
    names(indexedDB.databases ? indexedDB.databases().then((dbs) => dbs.map((d) => d.name)) : Promise.resolve([])),
    names(self.caches ? caches.keys() : Promise.resolve([])),
  ]).then(([idb, cacheNames]) => ({ origin: location.origin, entries, idb, cacheNames }));
}

function pageWrite(kind, op, key, value) {
  const store = kind === "session" ? sessionStorage : localStorage;
  if (op === "set") store.setItem(key, value);
  else if (op === "remove") store.removeItem(key);
  else if (op === "clear") store.clear();
  return store.length;
}

async function inTab(func, args) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId: CTX.tab.id }, func, args });
  return r && r.result;
}

// ---- UI ----

export function initStorageView(ctx) {
  CTX = ctx;
  document.querySelectorAll("#storage-kind .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => showKind(btn.dataset.kind));
  });
  $("storage-refresh").addEventListener("click", load);
  $("storage-add").addEventListener("click", () => openDialog(null));
  $("storage-export").addEventListener("click", exportAll);
  $("storage-clear").addEventListener("click", clearAll);
  $("storage-save").addEventListener("click", save);
}

function showKind(kind) {
  KIND = kind;
  document.querySelectorAll("#storage-kind .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
  const cookies = kind === "cookies";
  $("cookies-view").hidden = !cookies;
  $("storage-view").hidden = cookies;
  if (!cookies) load();
}

function label() {
  return KIND === "session" ? "sessionStorage" : "localStorage";
}

async function load() {
  const list = $("storage-list");
  $("storage-extra").textContent = "";
  if (!CTX.siteKey || CTX.siteKey === "file://" || CTX.tab?.id == null) {
    $("storage-count").textContent = "—";
    list.innerHTML = `<div class="empty muted">Storage is unavailable on this page.</div>`;
    return;
  }
  try {
    const data = await inTab(pageRead, [KIND, MAX_VALUE]);
    render(data);
  } catch (e) {
    $("storage-count").textContent = "—";
    list.innerHTML = "";
    const err = document.createElement("div");
    err.className = "empty muted";
    err.textContent = `Could not read ${label()}: ${e.message || e}`;
    list.appendChild(err);
  }
}

function render(data) {
  const list = $("storage-list");
  const n = data.entries.length;
  $("storage-count").textContent = `${n} key${n === 1 ? "" : "s"} · ${data.origin}`;
  list.innerHTML = "";
  if (!n) {
    const empty = document.createElement("div");
    empty.className = "empty muted";
    empty.textContent = `Nothing in ${label()} for this page.`;
    list.appendChild(empty);
  }
  for (const entry of data.entries) list.appendChild(renderRow(entry));
  const extra = [];
  if (data.idb.length) extra.push(`IndexedDB: ${data.idb.join(", ")}`);
  if (data.cacheNames.length) extra.push(`Cache Storage: ${data.cacheNames.join(", ")}`);
  $("storage-extra").textContent = extra.join("  ·  ");
}

function renderRow(entry) {
  const row = document.createElement("div");
  row.className = "cookie";

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = entry.key;
  row.appendChild(name);

  const actions = document.createElement("div");
  actions.className = "actions";
  const mk = (cls, title, text, fn) => {
    const b = document.createElement("button");
    b.className = `cookie-icon-btn ${cls}`;
    b.title = title;
    b.textContent = text;
    b.addEventListener("click", fn);
    actions.appendChild(b);
  };
  mk("edit", "Copy value", "⧉", async () => {
    await navigator.clipboard.writeText(entry.value);
    CTX.status(entry.clipped ? "Copied (clipped to 50,000 characters)" : "Value copied", "ok");
  });
  if (!entry.clipped) mk("edit", "Edit", "✎", () => openDialog(entry));
  mk("del", "Delete", "✕", async () => {
    await inTab(pageWrite, [KIND, "remove", entry.key, ""]);
    CTX.status(`Deleted "${entry.key}"`, "ok");
    load();
  });
  row.appendChild(actions);

  const value = document.createElement("div");
  value.className = "value";
  value.textContent = entry.value || "(empty)";
  value.title = "Click to expand / collapse";
  value.addEventListener("click", () => {
    const open = value.style.whiteSpace === "pre-wrap";
    value.style.whiteSpace = open ? "nowrap" : "pre-wrap";
    value.style.wordBreak = open ? "" : "break-all";
    if (!open) value.textContent = prettyIfJson(entry.value) || "(empty)";
    else value.textContent = entry.value || "(empty)";
  });
  row.appendChild(value);

  const meta = document.createElement("div");
  meta.className = "meta";
  const size = document.createElement("span");
  size.className = "badge";
  size.textContent = `${entry.size.toLocaleString()} chars${entry.clipped ? " (clipped)" : ""}`;
  meta.appendChild(size);
  if (looksJson(entry.value) && !entry.clipped) {
    const j = document.createElement("span");
    j.className = "badge sec";
    j.textContent = "JSON";
    meta.appendChild(j);
  }
  row.appendChild(meta);
  return row;
}

function looksJson(v) {
  if (!v || !/^[[{]/.test(v.trim())) return false;
  try {
    JSON.parse(v);
    return true;
  } catch {
    return false;
  }
}

function prettyIfJson(v) {
  return looksJson(v) ? JSON.stringify(JSON.parse(v), null, 2) : v;
}

function openDialog(entry) {
  $("storage-dialog-title").textContent = entry ? `Edit "${entry.key}"` : `New ${label()} key`;
  $("storage-key").value = entry ? entry.key : "";
  $("storage-key").readOnly = !!entry;
  $("storage-value").value = entry ? entry.value : "";
  $("storage-dialog").showModal();
}

async function save(e) {
  e.preventDefault();
  const key = $("storage-key").value;
  if (!key) return CTX.status("A key needs a name.", "err");
  $("storage-dialog").close();
  try {
    await inTab(pageWrite, [KIND, "set", key, $("storage-value").value]);
    CTX.status(`Saved "${key}". The page only notices if it re-reads ${label()}.`, "ok");
  } catch (err) {
    CTX.status(String(err.message || err), "err");
  }
  load();
}

// Full values (the list view clips long ones), JSON values parsed so the file
// is readable.
async function exportAll() {
  try {
    const data = await inTab(pageRead, [KIND, Number.MAX_SAFE_INTEGER]);
    const entries = {};
    for (const e of data.entries) entries[e.key] = looksJson(e.value) ? JSON.parse(e.value) : e.value;
    const out = { origin: data.origin, storage: label(), exportedAt: new Date().toISOString(), entries };
    const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
    const host = new URL(data.origin).host.replace(/[^a-z0-9.-]/gi, "_");
    await chrome.downloads.download({ url, filename: `combobreaker/${label()}-${host}.json` });
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    CTX.status(`Exported ${data.entries.length} key${data.entries.length === 1 ? "" : "s"} to Downloads/combobreaker`, "ok");
  } catch (err) {
    CTX.status(String(err.message || err), "err");
  }
}

async function clearAll() {
  if (!confirm(`Delete every ${label()} key for this page?`)) return;
  await inTab(pageWrite, [KIND, "clear", "", ""]);
  CTX.status(`${label()} cleared.`, "ok");
  load();
}
