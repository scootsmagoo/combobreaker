// Tracker highlighter — a visual privacy audit of the current page. Outlines
// tracking pixels, hidden iframes and anything that comes from a host on the
// Basic / Strong blocklists, and lists every such host in a panel (scripts and
// beacons have nothing to outline). A host that is getting through can be added
// to your own blocklist from its row; otherwise the tool changes nothing.
// Run it again, press Esc or click ✕ to remove it.

(() => {
  const ROOT_ID = "__cb_trackers_root__";
  const old = document.getElementById(ROOT_ID);
  if (old) {
    old.remove();
    return;
  }

  const COLORS = { blocked: "#34d399", loaded: "#f87171", pixel: "#fbbf24" };
  const pageHost = location.hostname;

  const hostOf = (url) => {
    try {
      const u = new URL(url, location.href);
      return /^https?:$/.test(u.protocol) ? u.hostname : "";
    } catch {
      return "";
    }
  };

  // ---- collect: [{ host, kind, el? }] ----
  const found = [];
  const tiny = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width <= 2 || r.height <= 2 || cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
  };
  // Chrome collapses a blocked <img> to 0×0, so a failed image is judged by
  // its declared size instead; without one it is assumed to be a real image.
  const isPixel = (img) => {
    if (img.complete && img.naturalWidth > 0) return img.naturalWidth <= 2 || img.naturalHeight <= 2 || tiny(img);
    const w = parseInt(img.getAttribute("width"), 10);
    const h = parseInt(img.getAttribute("height"), 10);
    return (w >= 0 && w <= 2) || (h >= 0 && h <= 2);
  };
  for (const el of document.querySelectorAll("img[src], iframe[src], script[src], embed[src], object[data]")) {
    const host = hostOf(el.currentSrc || el.src || el.data);
    if (!host) continue;
    const tag = el.tagName.toLowerCase();
    const kind = tag === "script" ? "script" : tag === "img" ? (isPixel(el) ? "pixel" : "image") : tiny(el) ? "hidden frame" : "frame";
    found.push({ host, kind, el: tag === "script" ? null : el });
  }
  // fetch / XHR / beacon / CSS requests have no element; resource timing still saw them.
  const domHosts = new Set(found.map((f) => f.host));
  for (const entry of performance.getEntriesByType("resource")) {
    const host = hostOf(entry.name);
    if (host && !domHosts.has(host)) found.push({ host, kind: entry.initiatorType === "xmlhttprequest" || entry.initiatorType === "fetch" ? "request" : entry.initiatorType || "request", el: null });
  }

  const hosts = [...new Set(found.map((f) => f.host))];

  chrome.runtime.sendMessage({ type: "classify-trackers", hosts }, (resp) => {
    const known = (resp && resp.ok && resp.result && resp.result.hosts) || {};
    render(known, resp && resp.ok ? resp.result : null);
  });

  function render(known, settings) {
    // A listed host is a tracker whatever it loads; an unlisted host only
    // counts when it serves an invisible pixel / frame from another site.
    const groups = new Map(); // host -> { host, list, blocked, kinds:Set, count, els[] }
    for (const f of found) {
      const hit = known[f.host];
      const sneaky = (f.kind === "pixel" || f.kind === "hidden frame") && f.host !== pageHost && !f.host.endsWith("." + pageHost.replace(/^www\./, ""));
      if (!hit && !sneaky) continue;
      let g = groups.get(f.host);
      if (!g) groups.set(f.host, (g = { host: f.host, list: hit ? hit.list : "", blocked: !!(hit && hit.blocked), kinds: new Set(), count: 0, els: [] }));
      g.kinds.add(f.kind);
      g.count += 1;
      if (f.el) g.els.push(f.el);
    }
    const rows = [...groups.values()].sort((a, b) => Number(a.blocked) - Number(b.blocked) || b.count - a.count);

    const root = document.createElement("div");
    root.id = ROOT_ID;
    Object.assign(root.style, { position: "absolute", top: "0", left: "0", width: "0", height: "0", zIndex: "2147483647" });
    const shadow = root.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .box { position: absolute; box-sizing: border-box; border: 2px solid; border-radius: 3px; pointer-events: none; }
      .box.flash { animation: flash 0.9s ease 2; }
      @keyframes flash { 50% { background: rgba(255,255,255,0.45); } }
      .dot { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; border: 2px solid #0c111d; pointer-events: none; }
      .tag { position: absolute; transform: translateY(-100%); font: 10px/1.3 ui-monospace, monospace; color: #0c111d; padding: 1px 5px; border-radius: 3px 3px 0 0; white-space: nowrap; pointer-events: none; }
      .panel { position: fixed; right: 12px; bottom: 12px; width: 340px; max-height: 60vh; display: flex; flex-direction: column;
        background: #0c111d; color: #e7eaf3; border: 1px solid #262d44; border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.5);
        font: 12px/1.45 -apple-system, "Segoe UI", sans-serif; }
      .head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid #262d44; font-weight: 600; }
      .head span { flex: 1; }
      .head button { background: none; border: none; color: #8b93a9; font-size: 14px; cursor: pointer; padding: 0 2px; }
      .head button:hover { color: #e7eaf3; }
      .sub { padding: 6px 12px; color: #8b93a9; border-bottom: 1px solid #262d44; }
      .list { overflow-y: auto; }
      .row { display: grid; grid-template-columns: 10px 1fr auto; gap: 8px; align-items: baseline; padding: 6px 12px; border-bottom: 1px solid #1a2033; }
      .row.has-el { cursor: pointer; }
      .row.has-el:hover { background: #151b2c; }
      .sw { width: 8px; height: 8px; border-radius: 50%; align-self: center; }
      .host { font-family: ui-monospace, monospace; word-break: break-all; }
      .kinds { color: #8b93a9; font-size: 11px; }
      .state { font-size: 11px; white-space: nowrap; text-align: right; }
      .block { display: block; margin: 3px 0 0 auto; background: none; border: 1px solid #3a4262; color: #e7eaf3; border-radius: 4px;
        font: inherit; font-size: 11px; padding: 1px 8px; cursor: pointer; }
      .block:hover { border-color: #f87171; color: #f87171; }
      .block:disabled { opacity: .6; cursor: default; border-color: #3a4262; color: #8b93a9; }
      .empty { padding: 18px 12px; color: #8b93a9; text-align: center; }
      .legend { display: flex; gap: 12px; padding: 7px 12px; color: #8b93a9; font-size: 11px; }
      .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
    `;
    shadow.appendChild(style);

    const colorOf = (g) => (g.blocked ? COLORS.blocked : g.list ? COLORS.loaded : COLORS.pixel);

    // ---- outlines, in page coordinates so they scroll with the content ----
    const boxes = new Map(); // element -> box/dot node
    for (const g of rows) {
      for (const el of g.els) {
        const r = el.getBoundingClientRect();
        const x = r.left + scrollX;
        const y = r.top + scrollY;
        const color = colorOf(g);
        let node;
        if (r.width > 6 && r.height > 6) {
          node = document.createElement("div");
          node.className = "box";
          Object.assign(node.style, { left: `${x}px`, top: `${y}px`, width: `${r.width}px`, height: `${r.height}px`, borderColor: color });
          const tag = document.createElement("div");
          tag.className = "tag";
          tag.style.background = color;
          tag.textContent = g.host;
          node.appendChild(tag);
        } else if (r.width || r.height || r.left || r.top) {
          node = document.createElement("div");
          node.className = "dot";
          node.title = g.host;
          Object.assign(node.style, { left: `${x}px`, top: `${y}px`, background: color });
        }
        if (node) {
          shadow.appendChild(node);
          boxes.set(el, node);
        }
      }
    }

    // ---- panel ----
    const panel = document.createElement("div");
    panel.className = "panel";
    const head = document.createElement("div");
    head.className = "head";
    const title = document.createElement("span");
    const active = rows.filter((g) => !g.blocked).length;
    title.textContent = rows.length ? `${rows.length} tracker host${rows.length === 1 ? "" : "s"} on this page` : "No trackers found";
    const close = document.createElement("button");
    close.textContent = "✕";
    close.title = "Close (Esc)";
    head.append(title, close);
    panel.appendChild(head);

    if (rows.length) {
      const sub = document.createElement("div");
      sub.className = "sub";
      const mode = !settings ? "" : settings.paused ? "Blocking is paused on this site." : settings.level === "off" ? "Blocking is off." : `Blocking: ${settings.level === "strong" ? "Strong" : "Basic"}.`;
      sub.textContent = `${rows.length - active} blocked, ${active} not blocked. ${mode}`;
      panel.appendChild(sub);
    }

    const list = document.createElement("div");
    list.className = "list";
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Nothing on this page comes from a host on the Basic or Strong list, and there are no hidden third-party pixels.";
      list.appendChild(empty);
    }
    for (const g of rows) {
      const row = document.createElement("div");
      row.className = "row";
      const sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = colorOf(g);
      const mid = document.createElement("div");
      const host = document.createElement("div");
      host.className = "host";
      host.textContent = g.host;
      const kinds = document.createElement("div");
      kinds.className = "kinds";
      kinds.textContent = `${[...g.kinds].join(", ")}${g.count > 1 ? ` ×${g.count}` : ""}${g.list ? ` · ${g.list === "custom" ? "your list" : g.list === "basic" ? "Basic list" : "Strong list"}` : " · not on a list"}`;
      mid.append(host, kinds);
      const state = document.createElement("div");
      state.className = "state";
      state.style.color = colorOf(g);
      const stateText = document.createElement("div");
      stateText.textContent = g.blocked ? "blocked" : g.list ? "not blocked" : "hidden pixel";
      state.appendChild(stateText);
      // The blocklist takes host names only, so an IP address gets no button.
      const blockable = /[a-z]/i.test(g.host) && g.host.includes(".");
      if (blockable && !g.blocked && !(settings && (settings.paused || settings.level === "off"))) {
        const block = document.createElement("button");
        block.className = "block";
        block.textContent = "Block";
        block.title = `Add ${g.host} to your blocklist (Options → Your blocklist to undo)`;
        block.addEventListener("click", (e) => {
          e.stopPropagation();
          block.disabled = true;
          chrome.runtime.sendMessage({ type: "custom-block-add", host: g.host }, (resp) => {
            if (resp && resp.ok) {
              block.textContent = "Added";
              stateText.textContent = "blocked from next load";
              state.style.color = COLORS.blocked;
              sw.style.background = COLORS.blocked;
            } else {
              block.textContent = "Can't block";
              block.title = (resp && resp.error) || "failed";
            }
          });
        });
        state.appendChild(block);
      }
      row.append(sw, mid, state);
      const target = g.els.find((el) => boxes.has(el));
      if (target) {
        row.classList.add("has-el");
        row.title = "Click to scroll to it";
        row.addEventListener("click", () => {
          target.scrollIntoView({ block: "center", behavior: "smooth" });
          const node = boxes.get(target);
          node.classList.remove("flash");
          void node.offsetWidth;
          node.classList.add("flash");
        });
      }
      list.appendChild(row);
    }
    panel.appendChild(list);

    const legend = document.createElement("div");
    legend.className = "legend";
    for (const [label, color] of [["blocked", COLORS.blocked], ["known, not blocked", COLORS.loaded], ["unlisted hidden pixel", COLORS.pixel]]) {
      const item = document.createElement("span");
      const dot = document.createElement("i");
      dot.style.background = color;
      item.append(dot, label);
      legend.appendChild(item);
    }
    panel.appendChild(legend);
    shadow.appendChild(panel);

    const remove = () => {
      root.remove();
      window.removeEventListener("keydown", onKey, true);
    };
    const onKey = (e) => {
      if (e.key === "Escape") remove();
    };
    close.addEventListener("click", remove);
    window.addEventListener("keydown", onKey, true);

    document.documentElement.appendChild(root);
  }
})();
