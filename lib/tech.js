// Tech stack detector: a signature table and a pure matcher. The service
// worker collects "signals" from the tab (a MAIN-world probe for globals and
// DOM, plus the main document's response headers it already captures) and
// detectTech() turns them into names. Zero network requests.
//
// Signature fields (any one hit is enough):
//   globals   : window property paths ("Shopify.shop")
//   selectors : CSS selectors that must match something
//   scripts   : RegExp tested against every <script src> and <link href>
//   generator : RegExp tested against <meta name="generator">
//   headers   : { name: RegExp } tested against the main document's response headers
//   flag      : name of a custom check done by the probe (React fibers etc.)
//   version   : key into signals.versions

export const TECH = [
  // Frameworks
  { name: "React", cat: "framework", globals: ["React"], selectors: ["[data-reactroot]"], flag: "react", version: "react" },
  { name: "Preact", cat: "framework", globals: ["preact"], flag: "preact" },
  { name: "Next.js", cat: "framework", globals: ["__NEXT_DATA__", "next.version"], selectors: ["#__next"], scripts: [/\/_next\/static\//], headers: { "x-powered-by": /next\.js/i }, version: "next" },
  { name: "Gatsby", cat: "framework", selectors: ["#___gatsby"], generator: /gatsby/i },
  { name: "Remix", cat: "framework", globals: ["__remixContext", "__remixManifest"] },
  { name: "Vue", cat: "framework", globals: ["Vue", "__VUE__"], selectors: ["[data-v-app]"], flag: "vue", version: "vue" },
  { name: "Nuxt", cat: "framework", globals: ["__NUXT__", "$nuxt", "useNuxtApp"], selectors: ["#__nuxt"], scripts: [/\/_nuxt\//] },
  { name: "Angular", cat: "framework", selectors: ["[ng-version]"], globals: ["ng.getComponent"], version: "angular" },
  { name: "AngularJS", cat: "framework", globals: ["angular.version"], selectors: ["[ng-app]", ".ng-scope"] },
  { name: "Svelte", cat: "framework", flag: "svelte" },
  { name: "SvelteKit", cat: "framework", globals: ["__sveltekit_dev"], selectors: ["[data-sveltekit-preload-data]", "[data-sveltekit-reload]"], scripts: [/\/_app\/immutable\//] },
  { name: "Astro", cat: "framework", selectors: ["astro-island", "[data-astro-cid]"], generator: /astro/i },
  { name: "Ember", cat: "framework", globals: ["Ember"], selectors: [".ember-application", ".ember-view"] },
  { name: "Backbone", cat: "library", globals: ["Backbone"] },
  { name: "Alpine.js", cat: "library", globals: ["Alpine"], selectors: ["[x-data]"] },
  { name: "htmx", cat: "library", globals: ["htmx"], selectors: ["[hx-get]", "[hx-post]", "[data-hx-get]"] },
  { name: "Hotwire Turbo", cat: "library", globals: ["Turbo"], selectors: ["turbo-frame"] },
  { name: "Stimulus", cat: "library", globals: ["Stimulus"], selectors: ["[data-controller]"] },
  { name: "jQuery", cat: "library", globals: ["jQuery"], scripts: [/jquery[.-][\w.-]*js/i], version: "jquery" },
  { name: "Lodash / Underscore", cat: "library", globals: ["_.VERSION"], scripts: [/lodash[.\w-]*\.js/i] },
  { name: "Bootstrap", cat: "ui", globals: ["bootstrap.Modal"], scripts: [/bootstrap[.\w-]*\.(js|css)/i] },
  { name: "Tailwind CSS", cat: "ui", flag: "tailwind", scripts: [/cdn\.tailwindcss\.com/] },
  { name: "Font Awesome", cat: "ui", scripts: [/font-?awesome|kit\.fontawesome\.com/i] },
  { name: "Google Fonts", cat: "ui", scripts: [/fonts\.googleapis\.com/] },

  // CMS / site builders / commerce
  { name: "WordPress", cat: "cms", generator: /wordpress/i, scripts: [/\/wp-(content|includes)\//], globals: ["wp.i18n", "wpApiSettings"] },
  { name: "WooCommerce", cat: "commerce", generator: /woocommerce/i, selectors: [".woocommerce"], globals: ["wc_add_to_cart_params"] },
  { name: "Shopify", cat: "commerce", globals: ["Shopify.shop", "ShopifyAnalytics"], scripts: [/cdn\.shopify\.com/], headers: { "x-shopid": /./, "powered-by": /shopify/i } },
  { name: "Magento", cat: "commerce", scripts: [/\/static\/version\d+\/frontend\//, /mage\/cookies/], globals: ["Mage"] },
  { name: "BigCommerce", cat: "commerce", scripts: [/cdn\d*\.bigcommerce\.com/], globals: ["BCData"] },
  { name: "Squarespace", cat: "cms", globals: ["Static.SQUARESPACE_CONTEXT"], scripts: [/static1?\.squarespace\.com/] },
  { name: "Wix", cat: "cms", globals: ["wixBiSession"], scripts: [/static\.(parastorage|wixstatic)\.com/], generator: /wix\.com/i },
  { name: "Webflow", cat: "cms", globals: ["Webflow"], selectors: ["html[data-wf-site]"], generator: /webflow/i },
  { name: "Ghost", cat: "cms", generator: /ghost/i },
  { name: "Drupal", cat: "cms", globals: ["Drupal"], generator: /drupal/i, headers: { "x-generator": /drupal/i, "x-drupal-cache": /./ } },
  { name: "Joomla", cat: "cms", generator: /joomla/i, globals: ["Joomla"] },
  { name: "Hugo", cat: "cms", generator: /hugo/i },
  { name: "Jekyll", cat: "cms", generator: /jekyll/i },
  { name: "Docusaurus", cat: "cms", generator: /docusaurus/i, selectors: ["#__docusaurus"] },
  { name: "Discourse", cat: "cms", generator: /discourse/i, globals: ["Discourse"] },
  { name: "HubSpot", cat: "cms", generator: /hubspot/i, scripts: [/js\.hs-scripts\.com|js\.hsforms\.net/] },

  // Analytics / marketing
  { name: "Google Analytics", cat: "analytics", globals: ["ga", "gtag", "GoogleAnalyticsObject"], scripts: [/google-analytics\.com|googletagmanager\.com\/gtag\/js/] },
  { name: "Google Tag Manager", cat: "analytics", globals: ["google_tag_manager"], scripts: [/googletagmanager\.com\/gtm\.js/] },
  { name: "Meta Pixel", cat: "analytics", globals: ["fbq"], scripts: [/connect\.facebook\.net\/.*fbevents/] },
  { name: "Hotjar", cat: "analytics", globals: ["hj"], scripts: [/static\.hotjar\.com/] },
  { name: "Segment", cat: "analytics", globals: ["analytics.identify"], scripts: [/cdn\.segment\.com/] },
  { name: "Mixpanel", cat: "analytics", globals: ["mixpanel"], scripts: [/cdn\.mxpnl\.com/] },
  { name: "Amplitude", cat: "analytics", globals: ["amplitude"], scripts: [/cdn\.amplitude\.com/] },
  { name: "PostHog", cat: "analytics", globals: ["posthog"] },
  { name: "Plausible", cat: "analytics", globals: ["plausible"], scripts: [/plausible\.io\/js/] },
  { name: "Matomo", cat: "analytics", globals: ["Matomo", "_paq"], scripts: [/matomo\.js|piwik\.js/] },
  { name: "Microsoft Clarity", cat: "analytics", globals: ["clarity"], scripts: [/clarity\.ms/] },
  { name: "Google AdSense", cat: "ads", globals: ["adsbygoogle"], scripts: [/pagead2\.googlesyndication\.com/] },

  // Services
  { name: "Sentry", cat: "service", globals: ["Sentry", "__SENTRY__"], scripts: [/browser\.sentry-cdn\.com/] },
  { name: "Intercom", cat: "service", globals: ["Intercom"], scripts: [/widget\.intercom\.io/] },
  { name: "Zendesk", cat: "service", globals: ["zE"], scripts: [/static\.zdassets\.com/] },
  { name: "Stripe", cat: "service", globals: ["Stripe"], scripts: [/js\.stripe\.com/] },
  { name: "PayPal", cat: "service", globals: ["paypal"], scripts: [/paypal\.com\/sdk\/js/] },
  { name: "reCAPTCHA", cat: "service", globals: ["grecaptcha"], scripts: [/recaptcha/] },
  { name: "hCaptcha", cat: "service", globals: ["hcaptcha"], scripts: [/hcaptcha\.com/] },
  { name: "Cloudflare Turnstile", cat: "service", globals: ["turnstile"], scripts: [/challenges\.cloudflare\.com\/turnstile/] },
  { name: "Disqus", cat: "service", globals: ["DISQUS"], scripts: [/disqus\.com\/embed/] },

  // Hosting / server (headers only)
  { name: "Cloudflare", cat: "hosting", headers: { server: /cloudflare/i, "cf-ray": /./ } },
  { name: "Vercel", cat: "hosting", headers: { server: /vercel/i, "x-vercel-id": /./ } },
  { name: "Netlify", cat: "hosting", headers: { server: /netlify/i, "x-nf-request-id": /./ } },
  { name: "GitHub Pages", cat: "hosting", headers: { server: /github\.com/i } },
  { name: "Fastly", cat: "hosting", headers: { "x-served-by": /cache-/i, "x-fastly-request-id": /./ } },
  { name: "Amazon CloudFront", cat: "hosting", headers: { via: /cloudfront/i, "x-amz-cf-id": /./ } },
  { name: "Akamai", cat: "hosting", headers: { server: /akamai/i, "x-akamai-transformed": /./ } },
  { name: "Fly.io", cat: "hosting", headers: { server: /fly\/|fly\.io/i, "fly-request-id": /./ } },
  { name: "nginx", cat: "server", headers: { server: /nginx/i } },
  { name: "Apache", cat: "server", headers: { server: /apache/i } },
  { name: "Microsoft IIS", cat: "server", headers: { server: /iis/i } },
  { name: "Express", cat: "server", headers: { "x-powered-by": /express/i } },
  { name: "PHP", cat: "server", headers: { "x-powered-by": /php/i } },
  { name: "ASP.NET", cat: "server", headers: { "x-powered-by": /asp\.net/i, "x-aspnet-version": /./ } },
  { name: "Ruby on Rails", cat: "server", selectors: ['meta[name="csrf-param"][content="authenticity_token"]'], headers: { "x-powered-by": /phusion|rails/i } },
  { name: "Django", cat: "server", selectors: ['input[name="csrfmiddlewaretoken"]'] },
  { name: "Laravel", cat: "server", globals: ["Laravel"] },
  { name: "Varnish", cat: "server", headers: { via: /varnish/i, "x-varnish": /./ } },
];

// What the probe needs to look for; passed to it as arguments.
export function probeInputs() {
  const globals = new Set();
  const selectors = new Set();
  for (const t of TECH) {
    for (const g of t.globals || []) globals.add(g);
    for (const s of t.selectors || []) selectors.add(s);
  }
  return { globals: [...globals], selectors: [...selectors] };
}

// signals = {
//   globals: string[], selectors: string[],   // the ones that hit
//   urls: string[], generator: string, flags: { [name]: true },
//   versions: { [key]: string }, headers: { [lowercased name]: string },
// }
export function detectTech(signals) {
  const s = signals || {};
  const globals = new Set(s.globals || []);
  const selectors = new Set(s.selectors || []);
  const urls = s.urls || [];
  const headers = s.headers || {};
  const out = [];
  for (const t of TECH) {
    const hit =
      (t.globals || []).some((g) => globals.has(g)) ||
      (t.selectors || []).some((sel) => selectors.has(sel)) ||
      (t.flag && s.flags && s.flags[t.flag]) ||
      (t.generator && t.generator.test(s.generator || "")) ||
      (t.scripts || []).some((re) => urls.some((u) => re.test(u))) ||
      Object.entries(t.headers || {}).some(([name, re]) => name in headers && re.test(headers[name]));
    if (!hit) continue;
    const version = (t.version && s.versions && s.versions[t.version]) || "";
    out.push({ name: t.name, cat: t.cat, version });
  }
  return out;
}
