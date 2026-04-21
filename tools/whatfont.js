// Font inspector — hover any element to see its font stack, size, weight,
// line-height, and color. Click an element to "pin" the readout, click again
// or press Esc to exit.

(() => {
  const ROOT_ID = "__cb_whatfont_root__";
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
    pointerEvents: "none",
  });
  document.documentElement.appendChild(root);

  const outline = document.createElement("div");
  Object.assign(outline.style, {
    position: "absolute",
    border: "2px solid #ec4899",
    borderRadius: "2px",
    pointerEvents: "none",
    transition: "all 0.05s linear",
  });
  root.appendChild(outline);

  const card = document.createElement("div");
  Object.assign(card.style, {
    position: "absolute",
    background: "#0c111d",
    color: "#e7eaf3",
    border: "1px solid #262d44",
    borderRadius: "8px",
    padding: "10px 12px",
    font: "12px/1.5 -apple-system, sans-serif",
    boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
    minWidth: "240px",
    maxWidth: "320px",
    pointerEvents: "none",
  });
  root.appendChild(card);

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
  });
  hint.textContent = "Hover to inspect. Click to pin. Esc to exit.";
  root.appendChild(hint);

  let pinned = false;

  function update(target) {
    if (!target || target === root || root.contains(target)) return;
    const r = target.getBoundingClientRect();
    outline.style.left = r.left - 2 + "px";
    outline.style.top = r.top - 2 + "px";
    outline.style.width = r.width + "px";
    outline.style.height = r.height + "px";

    const cs = getComputedStyle(target);
    const family = cs.fontFamily;
    const size = cs.fontSize;
    const weight = cs.fontWeight;
    const lh = cs.lineHeight;
    const color = cs.color;
    const ls = cs.letterSpacing;
    const ff = family.split(",")[0].replace(/['"]/g, "").trim();

    card.innerHTML = `
      <div style="font-size:11px;color:#98a0b8;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px;">
        &lt;${target.tagName.toLowerCase()}&gt;
      </div>
      <div style="font-family:${family};font-size:18px;font-weight:${weight};margin-bottom:8px;color:${color};">
        ${escapeHtml(ff || "Sans")}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        ${row("family", family)}
        ${row("size", size)}
        ${row("weight", weight)}
        ${row("line-height", lh)}
        ${row("letter-spacing", ls)}
        ${row("color", color)}
      </table>`;

    const cardW = 320;
    const cardH = card.offsetHeight || 180;
    let cx = r.left;
    let cy = r.bottom + 8;
    if (cy + cardH > innerHeight - 8) cy = r.top - cardH - 8;
    if (cx + cardW > innerWidth - 8) cx = innerWidth - cardW - 8;
    if (cy < 8) cy = 8;
    if (cx < 8) cx = 8;
    card.style.left = cx + "px";
    card.style.top = cy + "px";
  }

  function row(k, v) {
    return `<tr>
      <td style="color:#98a0b8;padding:1px 0;">${k}</td>
      <td style="font-family:ui-monospace,monospace;text-align:right;color:#38bdf8;padding:1px 0;">${escapeHtml(String(v))}</td>
    </tr>`;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function onMove(e) {
    if (pinned) return;
    update(e.target);
  }

  function onClick(e) {
    if (root.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    pinned = !pinned;
    if (pinned) update(e.target);
  }

  function onKey(e) {
    if (e.key === "Escape") destroy();
  }

  function destroy() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    root.remove();
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
})();
