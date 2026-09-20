// Link select: hold the trigger (Z by default) and drag a box over links to
// open them all in background tabs, open them in a new window, or copy them.
// The Linkclump idea, without the extension.
//
// While dragging:  T tabs · W window · C copy · S smart select on/off · Esc cancel
//
// Runs in the top frame of every page but does nothing until the trigger is
// used. The box and highlights live in a closed shadow root and use page
// coordinates, so scrolling mid-drag extends the selection. Cleaning, capping
// and formatting the links happens in the service worker (lib/links.js).

(() => {
  if (window.__cb_link_select) return;
  window.__cb_link_select = true;

  const CONFIRM_ABOVE = 25; // keep in step with LINKS_CONFIRM_ABOVE in lib/links.js
  const DRAG_THRESHOLD = 6; // px before a press becomes a selection
  const EDGE = 36; // px from a viewport edge where auto-scroll kicks in
  const ACTION_LABEL = { tabs: "open in tabs", window: "open in a new window", copy: "copy" };

  let cfg = { enabled: true, trigger: "z", action: "tabs", copyFormat: "urls", smart: true };
  let keyHeld = false; // the Z trigger
  let drag = null; // state of the selection in progress
  let suppressClick = false;
  let suppressMenu = false;
  let lastPlainRightClick = 0; // right-button trigger on macOS / Linux, see the contextmenu handler
  let menuHintShown = false;

  // ---- settings ----

  function applyGlobal(global) {
    const ls = (global && global.linkSelect) || {};
    cfg = {
      enabled: ls.enabled !== false,
      trigger: ["z", "shift", "alt", "right"].includes(ls.trigger) ? ls.trigger : "z",
      action: ["tabs", "window", "copy"].includes(ls.action) ? ls.action : "tabs",
      smart: ls.smart !== false,
    };
  }
  chrome.storage.sync.get("global").then((d) => applyGlobal(d.global)).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.global) applyGlobal(changes.global.newValue);
  });

  // ---- "armed" feedback ----
  //
  // While the Z trigger is held (and nothing is being dragged yet) the cursor
  // turns into a crosshair and a small pill says what to do. It answers "is
  // this thing on?" on the page itself. 180 ms delay: tapping Z for a site's
  // own shortcut never shows it.

  let armedUi = null;
  let armedTimer = 0;

  function showArmed() {
    if (armedUi || armedTimer) return;
    armedTimer = setTimeout(() => {
      armedTimer = 0;
      if (!keyHeld || drag) return;
      const host = document.createElement("div");
      Object.assign(host.style, { position: "fixed", left: "12px", bottom: "12px", zIndex: "2147483647", pointerEvents: "none" });
      const shadow = host.attachShadow({ mode: "closed" });
      const pill = document.createElement("div");
      pill.textContent = "Link select: drag over links";
      Object.assign(pill.style, {
        background: "#0c111d",
        color: "#e7eaf3",
        border: "1px solid #38bdf8",
        borderRadius: "12px",
        padding: "4px 10px",
        font: '12px/1.4 -apple-system, "Segoe UI", sans-serif',
      });
      shadow.appendChild(pill);
      const style = document.createElement("style");
      style.textContent = "* { cursor: crosshair !important; }";
      document.documentElement.append(host, style);
      armedUi = { host, style };
    }, 180);
  }

  function hideArmed() {
    clearTimeout(armedTimer);
    armedTimer = 0;
    if (!armedUi) return;
    armedUi.host.remove();
    armedUi.style.remove();
    armedUi = null;
  }

  // The popup asks whether link select is alive in this tab (Browse tab).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "cb-link-select-ping") return;
    sendResponse({ enabled: cfg.enabled, trigger: cfg.trigger, action: cfg.action });
  });

  // ---- trigger ----

  const inEditable = (el) => !!(el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName)));

  function triggerActive(e) {
    if (!cfg.enabled) return false;
    if (cfg.trigger === "right") return e.button === 2;
    if (e.button !== 0) return false;
    if (cfg.trigger === "shift") return e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (cfg.trigger === "alt") return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    return keyHeld;
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (drag && drag.active) return onDragKey(e);
      if (cfg.trigger !== "z" || e.ctrlKey || e.metaKey || e.altKey) return;
      // e.code as well: the physical Z key still works on layouts where it types something else.
      if ((e.key === "z" || e.key === "Z" || e.code === "KeyZ") && cfg.enabled && !inEditable(e.target)) {
        keyHeld = true;
        showArmed();
      }
    },
    true
  );
  window.addEventListener("keyup", (e) => {
    if (e.key === "z" || e.key === "Z" || e.code === "KeyZ") {
      keyHeld = false;
      hideArmed();
    }
  }, true);
  window.addEventListener("blur", () => {
    keyHeld = false;
    hideArmed();
    if (drag) cancel();
  });

  // ---- drag lifecycle ----

  window.addEventListener(
    "mousedown",
    (e) => {
      if (drag || !triggerActive(e) || inEditable(e.target)) return;
      // Stops text selection and native link dragging. A press that never
      // becomes a drag still produces its normal click / context menu.
      if (cfg.trigger !== "right") e.preventDefault();
      drag = {
        active: false,
        button: e.button,
        startX: e.pageX,
        startY: e.pageY,
        clientX: e.clientX,
        clientY: e.clientY,
        action: cfg.action,
        smart: cfg.smart,
        links: null,
        selected: [],
        ui: null,
        raf: 0,
      };
    },
    true
  );

  window.addEventListener(
    "mousemove",
    (e) => {
      if (!drag) return;
      drag.clientX = e.clientX;
      drag.clientY = e.clientY;
      if (!drag.active) {
        if (Math.abs(e.pageX - drag.startX) < DRAG_THRESHOLD && Math.abs(e.pageY - drag.startY) < DRAG_THRESHOLD) return;
        begin();
      }
      e.preventDefault();
      schedule();
    },
    true
  );

  window.addEventListener(
    "mouseup",
    (e) => {
      if (!drag || e.button !== drag.button) return;
      if (!drag.active) {
        if (drag.menuHeldBack) {
          lastPlainRightClick = Date.now();
          if (!menuHintShown) toast("Right-click again for the menu (link select is using the right button)");
          menuHintShown = true;
        }
        drag = null;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      suppressClick = true;
      suppressMenu = drag.button === 2;
      setTimeout(() => {
        suppressClick = false;
        suppressMenu = false;
      }, 400);
      update();
      finish();
    },
    true
  );

  // The mouseup of a drag that ended over a link would otherwise follow it.
  window.addEventListener(
    "click",
    (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
  // Windows fires contextmenu after mouseup, so only a finished drag has to
  // swallow it. macOS and Linux fire it on mouse*down*, before anyone can
  // know whether this press will become a drag: there the menu is held back,
  // and a second right-click within 0.7 s gets it (what Linkclump does too).
  window.addEventListener(
    "contextmenu",
    (e) => {
      if (drag && !drag.active && drag.button === 2) {
        if (Date.now() - lastPlainRightClick < 700) {
          drag = null; // the wanted menu: let it open, forget the press
          return;
        }
        drag.menuHeldBack = true;
      } else if (!suppressMenu && !(drag && drag.active)) {
        return;
      }
      suppressMenu = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
  window.addEventListener("scroll", () => drag && drag.active && schedule(), true);

  function onDragKey(e) {
    const k = e.key.toLowerCase();
    if (k === "escape") cancel();
    else if (k === "t") drag.action = "tabs";
    else if (k === "w") drag.action = "window";
    else if (k === "c") drag.action = "copy";
    else if (k === "s") drag.smart = !drag.smart;
    else if (k !== "z") return;
    e.preventDefault();
    e.stopPropagation();
    if (drag) schedule();
  }

  // ---- geometry ----

  // Every visible link with its rectangles in page coordinates, measured once
  // when the drag starts.
  function collectLinks() {
    const out = [];
    const sx = window.scrollX;
    const sy = window.scrollY;
    for (const a of document.querySelectorAll("a[href], area[href]")) {
      const rects = [];
      for (const r of a.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r);
      if (!rects.length) {
        // An <a> wrapping block content can have no box of its own.
        const kid = a.firstElementChild;
        const r = kid && kid.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) rects.push(r);
      }
      if (!rects.length) continue;
      out.push({
        el: a,
        rects: rects.map((r) => ({ l: r.left + sx, t: r.top + sy, r: r.right + sx, b: r.bottom + sy })),
        important: null, // filled lazily, only for links that enter the box
        shown: null,
      });
    }
    return out;
  }

  // "Headline" links: in a heading, or set in bold. When the box holds a mix,
  // smart select keeps only these (story titles, not "42 comments | share").
  function isImportant(link) {
    if (link.important != null) return link.important;
    const cs = getComputedStyle(link.el);
    if (cs.visibility === "hidden" || cs.display === "none") {
      link.hidden = true;
      return (link.important = false);
    }
    let important = !!link.el.closest("h1, h2, h3, h4, h5, h6");
    if (!important) {
      const probe = link.el.querySelector("b, strong") || link.el;
      important = Number(getComputedStyle(probe).fontWeight) >= 600;
    }
    return (link.important = important);
  }

  function currentBox() {
    const x = drag.clientX + window.scrollX;
    const y = drag.clientY + window.scrollY;
    return { l: Math.min(x, drag.startX), t: Math.min(y, drag.startY), r: Math.max(x, drag.startX), b: Math.max(y, drag.startY) };
  }

  const hits = (box, r) => r.l < box.r && r.r > box.l && r.t < box.b && r.b > box.t;

  // ---- UI ----

  function begin() {
    hideArmed();
    drag.active = true;
    drag.links = collectLinks();
    const host = document.createElement("div");
    Object.assign(host.style, { position: "absolute", top: "0", left: "0", width: "0", height: "0", zIndex: "2147483647" });
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .box { position: absolute; box-sizing: border-box; border: 1.5px dashed #38bdf8; background: rgba(56, 189, 248, 0.10); border-radius: 3px; pointer-events: none; }
      .hl { position: absolute; box-sizing: border-box; border: 2px solid #f59e0b; background: rgba(245, 158, 11, 0.18); border-radius: 3px; pointer-events: none; }
      .tip { position: absolute; white-space: nowrap; pointer-events: none; background: #0c111d; color: #e7eaf3; border: 1px solid #262d44;
        border-radius: 6px; padding: 4px 8px; font: 12px/1.4 -apple-system, "Segoe UI", sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.4); }
      .tip b { color: #38bdf8; }
      .tip small { display: block; color: #8b93a9; font-size: 10.5px; }
    `;
    const box = document.createElement("div");
    box.className = "box";
    const marks = document.createElement("div");
    const tip = document.createElement("div");
    tip.className = "tip";
    shadow.append(style, box, marks, tip);
    document.documentElement.appendChild(host);
    drag.ui = { host, box, marks, tip };
    // No text selection while the box is being drawn.
    drag.restoreSelect = document.documentElement.style.userSelect;
    document.documentElement.style.userSelect = "none";
  }

  function schedule() {
    if (!drag || drag.raf) return;
    drag.raf = requestAnimationFrame(() => {
      if (!drag) return;
      drag.raf = 0;
      autoScroll();
      update();
    });
  }

  function autoScroll() {
    const { clientX: x, clientY: y } = drag;
    const speed = (d) => Math.ceil(((EDGE - d) / EDGE) * 28);
    let dx = 0;
    let dy = 0;
    if (y < EDGE) dy = -speed(Math.max(y, 0));
    else if (y > window.innerHeight - EDGE) dy = speed(Math.max(window.innerHeight - y, 0));
    if (x < EDGE) dx = -speed(Math.max(x, 0));
    else if (x > window.innerWidth - EDGE) dx = speed(Math.max(window.innerWidth - x, 0));
    if (!dx && !dy) return;
    const before = window.scrollX + window.scrollY;
    window.scrollBy(dx, dy);
    if (window.scrollX + window.scrollY !== before) schedule(); // keep going while the pointer rests at the edge
  }

  function update() {
    const box = currentBox();
    const { ui } = drag;
    Object.assign(ui.box.style, { left: `${box.l}px`, top: `${box.t}px`, width: `${box.r - box.l}px`, height: `${box.b - box.t}px` });

    let inBox = drag.links.filter((link) => link.rects.some((r) => hits(box, r)));
    inBox.forEach(isImportant);
    inBox = inBox.filter((link) => !link.hidden);
    const important = inBox.filter((link) => link.important);
    const narrowed = drag.smart && important.length > 0 && important.length < inBox.length;
    drag.selected = narrowed ? important : inBox;

    const chosen = new Set(drag.selected);
    for (const link of drag.links) {
      if (chosen.has(link)) {
        if (!link.shown) {
          link.shown = link.rects.map((r) => {
            const d = document.createElement("div");
            d.className = "hl";
            Object.assign(d.style, { left: `${r.l - 2}px`, top: `${r.t - 2}px`, width: `${r.r - r.l + 4}px`, height: `${r.b - r.t + 4}px` });
            ui.marks.appendChild(d);
            return d;
          });
        }
      } else if (link.shown) {
        link.shown.forEach((d) => d.remove());
        link.shown = null;
      }
    }

    const urls = new Set(drag.selected.map((link) => link.el.href));
    drag.count = urls.size;
    ui.tip.textContent = "";
    const head = document.createElement("div");
    const n = document.createElement("b");
    n.textContent = String(urls.size);
    head.append(n, ` link${urls.size === 1 ? "" : "s"} · ${ACTION_LABEL[drag.action]}${narrowed ? " · headlines only" : ""}`);
    const keys = document.createElement("small");
    keys.textContent = `T tabs · W window · C copy · S smart ${drag.smart ? "off" : "on"} · Esc cancel`;
    ui.tip.append(head, keys);
    const px = drag.clientX + window.scrollX;
    const py = drag.clientY + window.scrollY;
    const flipX = drag.clientX > window.innerWidth - 300;
    const flipY = drag.clientY > window.innerHeight - 70;
    Object.assign(ui.tip.style, { left: flipX ? "" : `${px + 14}px`, right: "", top: `${flipY ? py - 52 : py + 16}px` });
    if (flipX) ui.tip.style.left = `${px - 14 - ui.tip.offsetWidth}px`;
  }

  function teardown() {
    if (!drag) return;
    if (drag.raf) cancelAnimationFrame(drag.raf);
    if (drag.ui) {
      drag.ui.host.remove();
      document.documentElement.style.userSelect = drag.restoreSelect || "";
    }
    drag = null;
  }

  function cancel() {
    // A cancelled right-drag must not pop the context menu on release.
    if (drag && drag.active && drag.button === 2) {
      suppressMenu = true;
      setTimeout(() => (suppressMenu = false), 1500);
    }
    teardown();
  }

  // ---- action ----

  function finish() {
    const action = drag.action;
    const links = drag.selected.map((link) => ({
      url: link.el.href,
      text: (link.el.innerText || link.el.textContent || link.el.getAttribute("title") || link.el.querySelector("img[alt]")?.alt || "").trim(),
    }));
    const count = drag.count;
    teardown();
    if (!links.length) return;
    if (action !== "copy" && count > CONFIRM_ABOVE && !window.confirm(`ComboBreaker: open ${count} links${action === "window" ? " in a new window" : " in new tabs"}?`)) return;
    chrome.runtime.sendMessage({ type: "links-action", action, links }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) return toast("Link select failed");
      const r = resp.result;
      if (action !== "copy") return;
      copyText(r.text).then(
        () => toast(`Copied ${r.count} link${r.count === 1 ? "" : "s"}`),
        () => toast("Could not copy (the page blocked clipboard access)")
      );
    });
  }

  // navigator.clipboard needs a secure context; plain-http pages get the old way.
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) return await navigator.clipboard.writeText(text);
    } catch (_) {
      // fall through
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    Object.assign(ta.style, { position: "fixed", top: "0", left: "0", opacity: "0" });
    document.documentElement.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("copy failed");
  }

  function toast(text) {
    const host = document.createElement("div");
    Object.assign(host.style, { position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647" });
    const shadow = host.attachShadow({ mode: "closed" });
    const el = document.createElement("div");
    el.textContent = text;
    Object.assign(el.style, {
      background: "#0c111d",
      color: "#e7eaf3",
      border: "1px solid #262d44",
      borderRadius: "6px",
      padding: "8px 12px",
      font: '12px/1.4 -apple-system, "Segoe UI", sans-serif',
      boxShadow: "0 6px 18px rgba(0,0,0,.45)",
    });
    shadow.appendChild(el);
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), 2200);
  }
})();
