// Loads article HTML from session storage (one-shot), then clears the key.
(function () {
  const KEY = "combobreaker_reader";
  const run = () => {
    const main = document.getElementById("reader-main");
    const line = document.getElementById("source-line");
    const fb = document.getElementById("reader-fallback");

    chrome.storage.session.get(KEY, (data) => {
      const p = data && data[KEY];
      chrome.storage.session.remove(KEY, () => {});

      if (!p || !p.html) {
        line.textContent = "";
        fb.hidden = false;
        return;
      }

      const t = p.title || "Reader";
      document.title = `Reader · ${t} · ComboBreaker`;
      line.textContent = p.url ? `Source: ${p.url}` : "";
      const art = document.createElement("article");
      if (p.lang) art.setAttribute("lang", p.lang);
      if (p.dir) art.setAttribute("dir", p.dir);
      const h1 = document.createElement("h1");
      h1.textContent = t;
      const body = document.createElement("div");
      body.className = "reader-content";
      body.innerHTML = p.html;
      art.appendChild(h1);
      art.appendChild(body);
      main.appendChild(art);
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
