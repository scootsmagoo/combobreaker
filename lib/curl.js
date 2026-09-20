// "Copy as cURL" for the Headers tab: a command that repeats the page's main
// request from a terminal, with this site's request-header overrides applied,
// so the response headers can be compared outside the browser. Cookies are
// deliberately left out: a clipboard is no place for session tokens.

// POSIX single-quoting: ' becomes '\'' and nothing else needs escaping.
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// overrides: the site's requestHeaders ([{ name, op, value }]).
export function buildCurl(url, { userAgent = "", overrides = [] } = {}) {
  if (!/^https?:\/\//i.test(String(url || ""))) return "";
  const parts = ["curl", "-sS", "-i", shellQuote(url)];
  const names = new Set(overrides.map((h) => String(h.name || "").toLowerCase()));
  if (userAgent && !names.has("user-agent")) parts.push("-A", shellQuote(userAgent));
  for (const h of overrides) {
    const name = String(h.name || "").trim();
    if (!name || /[\r\n:]/.test(name)) continue;
    // "Name:" with no value is curl's way of removing a header it would send.
    if (h.op === "remove") parts.push("-H", shellQuote(`${name}:`));
    else parts.push("-H", shellQuote(`${name}: ${String(h.value ?? "").replace(/[\r\n]+/g, " ")}`));
  }
  return parts.join(" ");
}
