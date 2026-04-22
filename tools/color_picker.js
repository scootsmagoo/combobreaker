// Color picker — uses Chrome's native window.EyeDropper API (Chromium 95+).
//
// EyeDropper.open() requires a transient user activation in the *page*
// document. Popup/keyboard-shortcut clicks don't propagate activation to
// the page, so we inject a one-shot overlay; the user's click on the
// overlay is a real page-side gesture, after which dropper.open() works.
//
// Copies the picked hex to clipboard and shows a toast for ~3 seconds.

(() => {
  if (window.__cbColorPickerArmed) return;
  window.__cbColorPickerArmed = true;

  if (!window.EyeDropper) {
    showToast("Your Chrome doesn't support EyeDropper API", true);
    window.__cbColorPickerArmed = false;
    return;
  }

  arm();

  function arm() {
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      background: "rgba(12,17,29,0.18)",
      cursor: "crosshair",
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "center",
      paddingTop: "24px",
      font: "13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    });

    const banner = document.createElement("div");
    Object.assign(banner.style, {
      background: "#0c111d",
      color: "#e7eaf3",
      border: "1px solid #262d44",
      borderRadius: "8px",
      padding: "10px 14px",
      boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
      pointerEvents: "none",
      userSelect: "none",
    });
    banner.innerHTML = `
      <span style="font-weight:700;color:#7dd3fc;">ComboBreaker</span>
      &nbsp;·&nbsp;Click anywhere to start the color picker
      &nbsp;<span style="color:#98a0b8;">(Esc to cancel)</span>`;
    overlay.appendChild(banner);

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      window.__cbColorPickerArmed = false;
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
      }
    };

    overlay.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        runDropper().finally(() => {
          done = true;
          window.__cbColorPickerArmed = false;
        });
      },
      { once: true, capture: true }
    );

    document.addEventListener("keydown", onKey, true);
    (document.body || document.documentElement).appendChild(overlay);
  }

  async function runDropper() {
    try {
      const dropper = new EyeDropper();
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
      showToast("Color pick failed: " + (err && err.message || err), true);
    }
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
      cursor: "pointer",
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
