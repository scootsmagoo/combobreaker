// Loads article HTML from session storage (one-shot), then clears the key.
(function () {
  const KEY = "combobreaker_reader";

  // The article HTML comes from an arbitrary web page and is rendered on an
  // extension origin. The extension CSP already blocks scripts; this strips
  // the rest of the active surface (forms, frames, handlers, script URLs).
  const DROP = "script,style,iframe,frame,object,embed,form,input,button,select,textarea,link,meta,base,noscript";
  function sanitizeArticle(html) {
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    doc.querySelectorAll(DROP).forEach((n) => n.remove());
    for (const el of doc.body.querySelectorAll("*")) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const isUrl = name === "href" || name === "src" || name === "xlink:href" || name === "action";
        if (
          name.startsWith("on") ||
          name === "style" ||
          name === "srcdoc" ||
          (isUrl && /^\s*(javascript|data|vbscript):/i.test(attr.value) && !/^\s*data:image\//i.test(attr.value))
        ) {
          el.removeAttribute(attr.name);
        }
      }
      if (el.tagName === "A") {
        el.setAttribute("rel", "noopener noreferrer");
        el.setAttribute("target", "_blank");
      }
    }
    const frag = document.createDocumentFragment();
    frag.append(...doc.body.childNodes);
    return frag;
  }
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
      body.appendChild(sanitizeArticle(p.html));
      art.appendChild(h1);
      art.appendChild(body);
      main.appendChild(art);
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
