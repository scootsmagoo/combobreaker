(function () {
  "use strict";

  const SESSION_KEY = "combobreaker_structured_data";

  async function init() {
    try {
      const data = await chrome.storage.session.get(SESSION_KEY);
      const payload = data[SESSION_KEY];
      if (!payload) {
        document.getElementById("sd-fallback").hidden = false;
        return;
      }

      // Display source line
      const srcLine = document.getElementById("source-line");
      if (payload.pageUrl) {
        srcLine.textContent = `${payload.pageTitle || "Untitled"} — ${payload.pageUrl}`;
      }

      displayMeta(payload.meta);

      // Display JSON-LD blocks
      displayJsonLd(payload);

      // Display other structured data
      displayOtherData(payload);

      // Display validator links
      displayValidators(payload.pageUrl);

      // Setup builder
      setupBuilder(payload);
    } catch (e) {
      console.error("Failed to load structured data:", e);
      document.getElementById("sd-fallback").hidden = false;
    }
  }

  // Everything in `meta` is page-controlled text: textContent only.
  function metaRow(table, label, value, showLen) {
    const tr = table.insertRow();
    const th = document.createElement("th");
    th.textContent = label;
    const td = tr.insertCell();
    tr.prepend(th);
    if (!value) {
      td.textContent = "—";
      td.className = "muted";
      return;
    }
    td.textContent = value;
    if (showLen) {
      const len = document.createElement("span");
      len.className = "len";
      len.textContent = `${value.length} chars`;
      td.appendChild(len);
    }
  }

  // [level, text]; thresholds are the usual search-snippet rules of thumb.
  function metaChecks(meta) {
    const checks = [];
    const t = meta.title.length;
    checks.push(!t ? ["bad", "No title"] : t > 60 ? ["warn", `Title is long (${t})`] : t < 10 ? ["warn", `Title is short (${t})`] : ["ok", "Title length"]);
    const d = meta.description.length;
    checks.push(!d ? ["bad", "No meta description"] : d > 160 ? ["warn", `Description is long (${d})`] : d < 50 ? ["warn", `Description is short (${d})`] : ["ok", "Description length"]);
    const h1 = meta.headingCounts.h1;
    checks.push(h1 === 1 ? ["ok", "One h1"] : h1 === 0 ? ["bad", "No h1"] : ["warn", `${h1} h1 headings`]);
    checks.push(meta.canonical ? ["ok", "Canonical set"] : ["warn", "No canonical link"]);
    checks.push(meta.lang ? ["ok", "lang attribute"] : ["warn", "No lang attribute"]);
    checks.push(meta.viewport ? ["ok", "Viewport meta"] : ["warn", "No viewport meta"]);
    if (/noindex/i.test(meta.robots)) checks.push(["bad", "robots: noindex"]);
    const og = new Set(meta.og.map((x) => x.key));
    const missingOg = ["og:title", "og:description", "og:image"].filter((k) => !og.has(k));
    checks.push(missingOg.length ? ["warn", `Missing ${missingOg.join(", ")}`] : ["ok", "Open Graph basics"]);
    const { total, missingAlt } = meta.images;
    checks.push(missingAlt ? ["warn", `${missingAlt} of ${total} images lack alt`] : ["ok", total ? "All images have alt" : "No images"]);
    return checks;
  }

  function displayMeta(meta) {
    if (!meta) return;
    document.getElementById("meta-section").hidden = false;

    const checksEl = document.getElementById("meta-checks");
    for (const [level, text] of metaChecks(meta)) {
      const chip = document.createElement("span");
      chip.className = `check ${level}`;
      chip.textContent = text;
      checksEl.appendChild(chip);
    }

    const table = document.getElementById("meta-table");
    metaRow(table, "Title", meta.title, true);
    metaRow(table, "Description", meta.description, true);
    metaRow(table, "Canonical", meta.canonical);
    metaRow(table, "Robots", meta.robots);
    metaRow(table, "Language", meta.lang);
    metaRow(table, "Viewport", meta.viewport);
    const hc = meta.headingCounts;
    metaRow(table, "Headings", Object.keys(hc).filter((k) => hc[k]).map((k) => `${k} ×${hc[k]}`).join("  "));
    const l = meta.links;
    metaRow(table, "Links", `${l.total} total · ${l.internal} internal · ${l.external} external · ${l.nofollow} nofollow`);
    if (meta.hreflang.length) metaRow(table, "hreflang", meta.hreflang.map((x) => x.key).join(", "));

    const social = document.getElementById("meta-social-table");
    const tags = [...meta.og, ...meta.twitter];
    document.getElementById("meta-social-count").textContent = `(${tags.length})`;
    for (const tag of tags) metaRow(social, tag.key, tag.value);
    if (!tags.length) metaRow(social, "None found", "");

    const outline = document.getElementById("meta-outline-list");
    document.getElementById("meta-outline-count").textContent = `(${meta.headings.length})`;
    for (const h of meta.headings) {
      const row = document.createElement("div");
      row.style.paddingLeft = `${(h.level - 1) * 18}px`;
      const tag = document.createElement("span");
      tag.className = "h-tag";
      tag.textContent = `h${h.level}`;
      row.append(tag, h.text || "(empty)");
      outline.appendChild(row);
    }

    if (meta.images.missingAlt) {
      document.getElementById("meta-alt").hidden = false;
      document.getElementById("meta-alt-count").textContent = `(${meta.images.missingAlt})`;
      const list = document.getElementById("meta-alt-list");
      for (const src of meta.images.samples) {
        const li = document.createElement("li");
        li.textContent = src || "(no src)";
        list.appendChild(li);
      }
    }
  }

  function displayJsonLd(payload) {
    const container = document.getElementById("jsonld-container");
    const countSpan = document.getElementById("jsonld-count");
    const blocks = payload.jsonld || [];

    if (blocks.length === 0) {
      container.innerHTML = '<p class="muted">No JSON-LD blocks found.</p>';
      countSpan.textContent = "(0)";
      return;
    }

    countSpan.textContent = `(${blocks.length})`;

    blocks.forEach((block, idx) => {
      const blockEl = document.createElement("div");
      blockEl.className = "jsonld-block";

      const header = document.createElement("div");
      header.className = "jsonld-header";

      const title = document.createElement("div");
      title.className = "jsonld-title";
      title.textContent = `Block ${idx + 1}`;
      header.appendChild(title);

      blockEl.appendChild(header);

      // Types
      if (block.types && block.types.length > 0) {
        const typesDiv = document.createElement("div");
        typesDiv.className = "jsonld-types";
        block.types.forEach((t) => {
          const badge = document.createElement("span");
          badge.className = "type-badge";
          badge.textContent = t;
          typesDiv.appendChild(badge);
        });
        blockEl.appendChild(typesDiv);
      }

      // Parse error
      if (block.parseError) {
        const errDiv = document.createElement("div");
        errDiv.className = "parse-error";
        errDiv.textContent = `Parse Error: ${block.parseError}`;
        blockEl.appendChild(errDiv);
      }

      // Heuristic notes
      const notes = analyzeBlock(block);
      if (notes.length > 0) {
        notes.forEach((note) => {
          const noteDiv = document.createElement("div");
          noteDiv.className = "note-box";
          noteDiv.textContent = `Note: ${note}`;
          blockEl.appendChild(noteDiv);
        });
      }

      // Pretty-printed JSON
      const pre = document.createElement("pre");
      try {
        const formatted = JSON.stringify(block.parsed || JSON.parse(block.raw), null, 2);
        pre.textContent = formatted;
      } catch (e) {
        pre.textContent = block.raw;
      }
      blockEl.appendChild(pre);

      // Buttons
      const btnRow = document.createElement("div");
      btnRow.className = "btn-row";

      const copyBtn = document.createElement("button");
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", () => copyText(block.raw, copyBtn));
      btnRow.appendChild(copyBtn);

      blockEl.appendChild(btnRow);
      container.appendChild(blockEl);
    });

    // Copy all button
    if (blocks.length > 1) {
      const copyAllBtn = document.createElement("button");
      copyAllBtn.textContent = "Copy All JSON-LD";
      copyAllBtn.className = "secondary";
      copyAllBtn.addEventListener("click", () => {
        const all = blocks.map((b) => b.raw).join("\n\n");
        copyText(all, copyAllBtn);
      });
      container.appendChild(copyAllBtn);
    }
  }

  function analyzeBlock(block) {
    const notes = [];
    if (!block.parsed) return notes;

    // Check for missing @context
    if (!block.parsed["@context"]) {
      notes.push("Missing @context — standalone objects should include context");
    }

    // Check for @graph without context
    if (block.parsed["@graph"] && !block.parsed["@context"]) {
      notes.push("@graph found without @context");
    }

    return notes;
  }

  function displayOtherData(payload) {
    const container = document.getElementById("other-section");

    // Microdata
    const microDiv = document.createElement("div");
    microDiv.className = "summary-item";
    const microTitle = document.createElement("div");
    microTitle.className = "summary-title";
    microTitle.textContent = "Microdata";
    microDiv.appendChild(microTitle);

    const microValue = document.createElement("div");
    microValue.className = "summary-value";
    const md = payload.microdata || {};
    if (md.itemscopeCount === 0) {
      microValue.textContent = "No microdata found";
    } else {
      microValue.textContent = `${md.itemscopeCount} itemscope elements`;
      if (md.itemtypes && md.itemtypes.length > 0) {
        const typesList = document.createElement("div");
        typesList.style.marginTop = "8px";
        const strong = document.createElement("strong");
        strong.textContent = "Types:";
        // Page-controlled strings: never through innerHTML.
        typesList.append(strong, " " + md.itemtypes.join(", "));
        microDiv.appendChild(typesList);
      }
    }
    microDiv.appendChild(microValue);
    container.appendChild(microDiv);

    // RDFa
    const rdfaDiv = document.createElement("div");
    rdfaDiv.className = "summary-item";
    const rdfaTitle = document.createElement("div");
    rdfaTitle.className = "summary-title";
    rdfaTitle.textContent = "RDFa";
    rdfaDiv.appendChild(rdfaTitle);

    const rdfaValue = document.createElement("div");
    rdfaValue.className = "summary-value";
    const rdfa = payload.rdfa || {};
    if (rdfa.elementCount === 0) {
      rdfaValue.textContent = "No RDFa found";
    } else {
      rdfaValue.textContent = `${rdfa.elementCount} elements with typeof`;
      if (rdfa.typofs && rdfa.typofs.length > 0) {
        const typesList = document.createElement("div");
        typesList.style.marginTop = "8px";
        const strong = document.createElement("strong");
        strong.textContent = "Types:";
        // Page-controlled strings: never through innerHTML.
        typesList.append(strong, " " + rdfa.typofs.join(", "));
        rdfaDiv.appendChild(typesList);
      }
    }
    rdfaDiv.appendChild(rdfaValue);
    container.appendChild(rdfaDiv);
  }

  function displayValidators(pageUrl) {
    const container = document.getElementById("validator-links");
    if (!pageUrl) {
      container.textContent = "No page URL available for validation.";
      return;
    }

    const encodedUrl = encodeURIComponent(pageUrl);
    const links = [
      {
        text: "Google Rich Results Test",
        url: `https://search.google.com/test/rich-results?url=${encodedUrl}`,
      },
      {
        text: "Schema.org Validator",
        url: `https://validator.schema.org/#url=${encodedUrl}`,
      },
    ];

    links.forEach((link) => {
      const a = document.createElement("a");
      a.href = link.url;
      a.textContent = link.text;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      container.appendChild(a);
    });
  }

  function setupBuilder(payload) {
    const typeSelect = document.getElementById("builder-type");
    const fieldsDiv = document.getElementById("builder-fields");
    const generateBtn = document.getElementById("builder-generate");
    const outputDiv = document.getElementById("builder-output");

    function renderFields() {
      const type = typeSelect.value;
      fieldsDiv.innerHTML = "";

      const commonFields = [
        { name: "name", label: "Name", type: "text" },
        { name: "url", label: "URL", type: "url", value: payload.pageUrl || "" },
      ];

      const typeFields = {
        WebSite: [
          { name: "url", label: "URL", type: "url", value: payload.pageUrl || "" },
          { name: "name", label: "Name", type: "text", value: payload.pageTitle || "" },
          { name: "description", label: "Description", type: "text" },
        ],
        Organization: [
          { name: "name", label: "Name", type: "text" },
          { name: "url", label: "URL", type: "url", value: payload.pageUrl || "" },
          { name: "logo", label: "Logo URL", type: "url" },
        ],
        Article: [
          { name: "headline", label: "Headline", type: "text", value: payload.pageTitle || "" },
          { name: "url", label: "URL", type: "url", value: payload.pageUrl || "" },
          { name: "datePublished", label: "Date Published", type: "date" },
          { name: "author", label: "Author Name", type: "text" },
        ],
        Product: [
          { name: "name", label: "Product Name", type: "text" },
          { name: "description", label: "Description", type: "text" },
          { name: "image", label: "Image URL", type: "url" },
          { name: "offers.price", label: "Price", type: "text" },
          { name: "offers.priceCurrency", label: "Currency", type: "text", value: "USD" },
        ],
        BreadcrumbList: [
          { name: "itemListElement", label: "Items (one per line: Name|URL)", type: "textarea" },
        ],
        FAQPage: [
          { name: "mainEntity", label: "FAQs (one per line: Question|Answer)", type: "textarea" },
        ],
      };

      const fields = typeFields[type] || commonFields;

      fields.forEach((field) => {
        const label = document.createElement("label");
        label.textContent = field.label;

        let input;
        if (field.type === "textarea") {
          input = document.createElement("textarea");
        } else {
          input = document.createElement("input");
          input.type = field.type;
        }
        input.id = `field-${field.name}`;
        input.value = field.value || "";

        label.appendChild(input);
        fieldsDiv.appendChild(label);
      });
    }

    typeSelect.addEventListener("change", renderFields);
    renderFields();

    generateBtn.addEventListener("click", () => {
      const type = typeSelect.value;
      const obj = {
        "@context": "https://schema.org",
        "@type": type,
      };

      // Collect field values
      const inputs = fieldsDiv.querySelectorAll("input, textarea");
      inputs.forEach((inp) => {
        const fieldName = inp.id.replace("field-", "");
        let val = inp.value.trim();
        if (!val) return;

        if (fieldName === "itemListElement" && type === "BreadcrumbList") {
          const items = val.split("\n").map((line, idx) => {
            const [name, url] = line.split("|").map((s) => s.trim());
            return {
              "@type": "ListItem",
              position: idx + 1,
              name: name || "",
              item: url || "",
            };
          });
          obj.itemListElement = items;
        } else if (fieldName === "mainEntity" && type === "FAQPage") {
          const faqs = val.split("\n").map((line) => {
            const [q, a] = line.split("|").map((s) => s.trim());
            return {
              "@type": "Question",
              name: q || "",
              acceptedAnswer: {
                "@type": "Answer",
                text: a || "",
              },
            };
          });
          obj.mainEntity = faqs;
        } else if (fieldName.includes(".")) {
          const parts = fieldName.split(".");
          if (!obj[parts[0]]) obj[parts[0]] = {};
          obj[parts[0]][parts[1]] = val;
        } else if (fieldName === "author" && type === "Article") {
          obj.author = { "@type": "Person", name: val };
        } else {
          obj[fieldName] = val;
        }
      });

      // Offer price wrapper for Product
      if (type === "Product" && obj.offers) {
        obj.offers["@type"] = "Offer";
      }

      const minified = JSON.stringify(obj);
      const pretty = JSON.stringify(obj, null, 2);

      outputDiv.innerHTML = "";

      const prettyPre = document.createElement("pre");
      prettyPre.textContent = pretty;
      outputDiv.appendChild(prettyPre);

      const btnRow = document.createElement("div");
      btnRow.className = "btn-row";

      const copyBtn = document.createElement("button");
      copyBtn.textContent = "Copy Minified";
      copyBtn.addEventListener("click", () => copyText(minified, copyBtn));
      btnRow.appendChild(copyBtn);

      const copyPrettyBtn = document.createElement("button");
      copyPrettyBtn.textContent = "Copy Pretty";
      copyPrettyBtn.addEventListener("click", () => copyText(pretty, copyPrettyBtn));
      btnRow.appendChild(copyPrettyBtn);

      const copyWrappedBtn = document.createElement("button");
      copyWrappedBtn.textContent = "Copy with <script> tag";
      copyWrappedBtn.className = "secondary";
      copyWrappedBtn.addEventListener("click", () => {
        const wrapped = `<script type="application/ld+json">\n${pretty}\n</script>`;
        copyText(wrapped, copyWrappedBtn);
      });
      btnRow.appendChild(copyWrappedBtn);

      outputDiv.appendChild(btnRow);
    });
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      const origText = button.textContent;
      button.textContent = "Copied!";
      button.classList.add("copy-success");
      setTimeout(() => {
        button.textContent = origText;
        button.classList.remove("copy-success");
      }, 1500);
    } catch (e) {
      alert("Copy failed: " + e.message);
    }
  }

  init();
})();
