// Color picker — uses Chrome's native window.EyeDropper API (Chromium 95+).
// Copies the picked hex to clipboard and shows a toast for ~3 seconds.

(async () => {
  if (!window.EyeDropper) {
    showToast("Your Chrome doesn't support EyeDropper API", true);
    return;
  }

  const dropper = new EyeDropper();
  try {
    const result = await dropper.open();
    const hex = result.sRGBHex.toUpperCase();

    let copied = false;
    try {
      await navigator.clipboard.writeText(hex);
      copied = true;
    } catch {
      copied = false;
    }
    showSwatch(hex, copied);
  } catch (err) {
    if (err && err.name === "AbortError") return;
    showToast("Color pick failed: " + err.message, true);
  }

  function showSwatch(hex, copied) {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "2147483647",
      background: "#0c111d",
      color: "#e7eaf3",
      border: "1px solid #262d44",
      borderRadius: "8px",
      padding: "10px 12px",
      font: "13px/1.4 -apple-system, sans-serif",
      boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
      display: "flex",
      gap: "10px",
      alignItems: "center",
      transition: "opacity 0.3s ease",
    });
    wrap.innerHTML = `
      <span style="display:inline-block;width:32px;height:32px;border-radius:6px;background:${hex};border:1px solid #262d44;"></span>
      <div>
        <div style="font-weight:700;font-family:ui-monospace,monospace;">${hex}</div>
        <div style="font-size:11px;color:${copied ? "#22c55e" : "#98a0b8"};">${copied ? "copied to clipboard" : "click to copy"}</div>
      </div>`;
    wrap.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(hex);
        wrap.lastElementChild.lastElementChild.textContent = "copied to clipboard";
        wrap.lastElementChild.lastElementChild.style.color = "#22c55e";
      } catch {}
    });
    document.documentElement.appendChild(wrap);
    setTimeout(() => {
      wrap.style.opacity = "0";
      setTimeout(() => wrap.remove(), 350);
    }, 3500);
  }

  function showToast(text, isErr) {
    const t = document.createElement("div");
    Object.assign(t.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "2147483647",
      background: "#0c111d",
      color: isErr ? "#ef4444" : "#e7eaf3",
      border: "1px solid " + (isErr ? "#ef4444" : "#262d44"),
      borderRadius: "8px",
      padding: "10px 12px",
      font: "13px/1.4 -apple-system, sans-serif",
    });
    t.textContent = text;
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }
})();
