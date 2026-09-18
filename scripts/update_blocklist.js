#!/usr/bin/env node
// Regenerates rules/strong_block.json, the "Strong" ad/tracker ruleset, from
// Peter Lowe's ad and tracking server list (https://pgl.yoyo.org/adservers/).
//
//   node scripts/update_blocklist.js
//
// The list is fetched at build time only; the extension itself never contacts
// pgl.yoyo.org. Domains are packed into a handful of declarativeNetRequest
// rules (requestDomains takes many domains per rule, and matches subdomains),
// third-party only, so visiting one of these sites directly still works.

const fs = require("fs");
const path = require("path");

const SOURCE = "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext";
const OUT = path.resolve(__dirname, "..", "rules", "strong_block.json");
const META = path.resolve(__dirname, "..", "rules", "strong_block.meta.json");
const CHUNK = 500;
const FIRST_ID = 1000; // basic_block.json uses 1..999
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

// Never block these even if the upstream list ever adds them: breaking them
// breaks sign-in or payments rather than ads.
const NEVER = new Set(["google.com", "accounts.google.com", "paypal.com", "stripe.com", "apple.com", "microsoft.com"]);

async function main() {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const domains = [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((l) => l.trim().toLowerCase())
        .filter((l) => l && !l.startsWith("#") && DOMAIN_RE.test(l) && !NEVER.has(l))
    ),
  ].sort();
  if (domains.length < 1000) throw new Error(`only ${domains.length} domains parsed; refusing to overwrite the ruleset`);

  const rules = [];
  for (let i = 0; i < domains.length; i += CHUNK) {
    rules.push({
      id: FIRST_ID + rules.length,
      priority: 1,
      action: { type: "block" },
      condition: { requestDomains: domains.slice(i, i + CHUNK), domainType: "thirdParty" },
    });
  }
  fs.writeFileSync(OUT, JSON.stringify(rules) + "\n");
  fs.writeFileSync(
    META,
    JSON.stringify(
      { source: "https://pgl.yoyo.org/adservers/", generated: new Date().toISOString().slice(0, 10), domains: domains.length, rules: rules.length },
      null,
      2
    ) + "\n"
  );
  console.log(`${path.relative(process.cwd(), OUT)}: ${domains.length} domains in ${rules.length} rules`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
