// Pixel ruler — click and drag to measure. Esc or right-click closes it.
// All UI sits in a single fixed root with a high z-index.

(() => {
  const ROOT_ID = "__cb_ruler_root__";
  if (document.getElementById(ROOT_ID)) {
    document.getElementById(ROOT_ID).remove();
    return;
  }

  const root = document.createElement("div");
  root.id = ROOT_ID;
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    cursor: "crosshair",
    background: "rgba(56, 189, 248, 0.04)",
  });
  document.documentElement.appendChild(root);

  const hint = document.createElement("div");
  Object.assign(hint.style, {
    position: "absolute",
    top: "10px",
    left: "10px",
    background: "#0c111d",
    color: "#e7eaf3",
    border: "1px solid #262d44",
    borderRadius: "6px",
    padding: "6px 10px",
    font: "12px/1.4 -apple-system, sans-serif",
    pointerEvents: "none",
  });
  hint.textContent = "Click & drag to measure. Esc to exit.";
  root.appendChild(hint);

  let drag = null;
  const rect = document.createElement("div");
  Object.assign(rect.style, {
    position: "absolute",
    background: "rgba(56, 189, 248, 0.15)",
    border: "1px solid #38bdf8",
    pointerEvents: "none",
    display: "none",
  });
  root.appendChild(rect);

  const label = document.createElement("div");
  Object.assign(label.style, {
    position: "absolute",
    background: "#0c111d",
    color: "#38bdf8",
    border: "1px solid #38bdf8",
    borderRadius: "4px",
    padding: "3px 6px",
    font: "11px/1.4 ui-monospace, monospace",
    pointerEvents: "none",
    display: "none",
    whiteSpace: "nowrap",
  });
  root.appendChild(label);

  function onDown(e) {
    if (e.button !== 0) {
      destroy();
      return;
    }
    drag = { x: e.clientX, y: e.clientY };
    rect.style.display = "block";
    label.style.display = "block";
    update(e);
    e.preventDefault();
  }

  function onMove(e) {
    if (!drag) return;
    update(e);
    e.preventDefault();
  }

  function onUp() {
    drag = null;
  }

  function update(e) {
    const x1 = Math.min(drag.x, e.clientX);
    const y1 = Math.min(drag.y, e.clientY);
    const w = Math.abs(e.clientX - drag.x);
    const h = Math.abs(e.clientY - drag.y);
    rect.style.left = x1 + "px";
    rect.style.top = y1 + "px";
    rect.style.width = w + "px";
    rect.style.height = h + "px";
    label.style.left = (x1 + w + 6) + "px";
    label.style.top = (y1 + h + 6) + "px";
    const dist = Math.round(Math.hypot(w, h));
    label.textContent = `${w} × ${h} px  (∠${dist})`;
  }

  function destroy() {
    root.remove();
    document.removeEventListener("keydown", onKey);
  }

  function onKey(e) {
    if (e.key === "Escape") destroy();
  }

  root.addEventListener("mousedown", onDown);
  root.addEventListener("mousemove", onMove);
  root.addEventListener("mouseup", onUp);
  root.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    destroy();
  });
  document.addEventListener("keydown", onKey);
})();
