/**
 * scripts/buildSite.js
 * Builds the public static website (home + privacy policy + 404) from businessKnowledge.js,
 * so prices and hours on the site always match what the WhatsApp bot says.
 *
 *   npm run site:build                       -> site/dist (deploy to Cloudflare Pages)
 *   SITE_ALLOW_PLACEHOLDERS=true npm run site:build   -> local preview with [EDIT] values
 *
 * No JavaScript on the generated pages; static assets are copied from site/public.
 */

const fs = require('fs');
const path = require('path');

const { businessKnowledge } = require('../src/config/businessKnowledge');
const { esc } = require('../src/views/html');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'site', 'public');
const DEFAULT_OUT_DIR = path.join(ROOT, 'site', 'dist');
const QR_FILE = 'whatsapp-qr.png'; // optional: QR downloaded from WhatsApp Manager -> Message links

// ---------------------------------------------------------------------------
// 1. Validation
// ---------------------------------------------------------------------------

/**
 * Lists problems that would publish wrong or placeholder details.
 * @param {object} kb businessKnowledge
 * @returns {string[]} human-readable problems (empty = OK)
 */
const findProblems = (kb) => {
  const problems = [];
  const check = (label, value) => {
    if (typeof value === 'string' && value.includes('[EDIT]')) problems.push(`${label} still has [EDIT]`);
  };
  ['name', 'description', 'hours', 'serviceArea', 'contactPhone', 'whatsappNumber', 'email', 'address'].forEach((key) =>
    check(key, kb[key])
  );
  (kb.services || []).forEach((s, i) => check(`services[${i}].price`, s.price));
  (kb.policies || []).forEach((p, i) => check(`policies[${i}]`, p));

  if (!/^\d{10,15}$/.test(String(kb.whatsappNumber || '').replace(/^\[EDIT\]\s*/, ''))) {
    problems.push('whatsappNumber must be digits only with country code, e.g. 919876543210');
  }
  return problems;
};

// Placeholder previews: show values without the "[EDIT] " marker.
const clean = (value) => String(value ?? '').replace(/\[EDIT\]\s*/g, '');

/**
 * wa.me chat link with a prefilled message ("Hi" opens the bot's welcome menu).
 * @param {string} number digits with country code
 * @param {string} [text]
 */
const whatsappLink = (number, text = 'Hi') =>
  `https://wa.me/${clean(number).replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;

// ---------------------------------------------------------------------------
// 2. Page layout
// ---------------------------------------------------------------------------

const layout = ({ kb, title, description, body }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#0b6e6e">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="top">
  <div class="wrap top-inner">
    <a class="brand" href="/">${esc(clean(kb.name))}</a>
    <a class="btn btn-wa small" href="${esc(whatsappLink(kb.whatsappNumber))}" rel="noopener">Chat on WhatsApp</a>
  </div>
</header>
${body}
<footer class="foot">
  <div class="wrap">
    <p><strong>${esc(clean(kb.name))}</strong> · ${esc(clean(kb.address))}</p>
    <p>${esc(clean(kb.contactPhone))} · <a href="mailto:${esc(clean(kb.email))}">${esc(clean(kb.email))}</a></p>
    <p><a href="/privacy">Privacy policy</a> · © ${new Date().getFullYear()} ${esc(clean(kb.name))}</p>
  </div>
</footer>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// 3. Pages
// ---------------------------------------------------------------------------

const formatSlot = ({ start, end }) => `${start} – ${end}`;

const homePage = (kb, { hasQr }) => {
  const wa = whatsappLink(kb.whatsappNumber);
  const services = (kb.services || [])
    .map(
      (s) => `<li class="card service">
        <h3>${esc(s.name)}</h3>
        <p class="price">${esc(clean(s.price))}</p>
        <p class="muted">Ready in ${esc(s.turnaround)}</p>
      </li>`
    )
    .join('\n');
  const policies = (kb.policies || []).map((p) => `<li>${esc(clean(p))}</li>`).join('\n');
  const slots = (kb.pickupSlots || []).map(formatSlot).join(', ');
  const qr = hasQr
    ? `<figure class="qr"><img src="/${QR_FILE}" width="200" height="200" alt="QR code: scan to chat with ${esc(clean(kb.name))} on WhatsApp"><figcaption class="muted">Scan with your phone camera</figcaption></figure>`
    : '';

  const body = `<main>
<section class="hero">
  <div class="wrap hero-inner">
    <div>
      <h1>${esc(clean(kb.name))}</h1>
      <p class="lead">${esc(clean(kb.description))}</p>
      <p>Book a pickup, track your order or ask a question — all on WhatsApp, any time.</p>
      <a class="btn btn-wa" href="${esc(wa)}" rel="noopener">Book a pickup on WhatsApp</a>
    </div>
    ${qr}
  </div>
</section>

<section class="wrap" aria-labelledby="how">
  <h2 id="how">How it works</h2>
  <ol class="steps">
    <li class="card"><span class="num">1</span><h3>Message us</h3><p>Say “Hi” on WhatsApp and tap <em>Book pickup</em>.</p></li>
    <li class="card"><span class="num">2</span><h3>Pick a slot</h3><p>Choose a service, a pickup time and your address.</p></li>
    <li class="card"><span class="num">3</span><h3>We collect &amp; deliver</h3><p>Get WhatsApp updates until your clothes are back.</p></li>
  </ol>
</section>

<section class="wrap" aria-labelledby="prices">
  <h2 id="prices">Services &amp; prices</h2>
  <ul class="services">
${services}
  </ul>
</section>

<section class="wrap info" aria-labelledby="info">
  <h2 id="info">Good to know</h2>
  <div class="card">
    <p><strong>Opening hours:</strong> ${esc(clean(kb.hours))}</p>
    ${slots ? `<p><strong>Pickup slots:</strong> ${esc(slots)}</p>` : ''}
    <p><strong>Service area:</strong> ${esc(clean(kb.serviceArea))}</p>
    ${policies ? `<ul>${policies}</ul>` : ''}
  </div>
</section>
</main>`;

  return layout({
    kb,
    title: `${clean(kb.name)} — laundry pickup & delivery`,
    description: clean(kb.description),
    body,
  });
};

const privacyPage = (kb) => {
  const name = esc(clean(kb.name));
  const email = esc(clean(kb.email));
  const body = `<main class="wrap prose">
<h1>Privacy policy</h1>
<p class="muted">Last updated: ${esc(new Date().toISOString().slice(0, 10))}</p>

<p>${name} (“we”) provides laundry pickup and delivery. This policy explains what we collect when you use our WhatsApp service, website and payment pages, and how we use it.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Contact details:</strong> your WhatsApp phone number and profile name.</li>
  <li><strong>Booking details:</strong> service, quantity, pickup time, address, instructions and order status.</li>
  <li><strong>Location:</strong> if you share a WhatsApp location or a Google Maps link, we use it to check that you are inside our service area and to reach your address.</li>
  <li><strong>Messages:</strong> the messages you send us and our replies, so we can answer you and improve our answers.</li>
  <li><strong>Payments:</strong> amounts, payment status and payment reference numbers. Card and UPI details are handled by the payment provider; we never see or store them.</li>
</ul>

<h2>How we use it</h2>
<ul>
  <li>To take, carry out, update and support your orders.</li>
  <li>To send you order confirmations and status updates on WhatsApp.</li>
  <li>To answer questions, including with automated replies.</li>
  <li>To keep records required for accounting and tax.</li>
</ul>
<p>We do not sell your data or use it for advertising.</p>

<h2>Who processes it for us</h2>
<ul>
  <li><strong>Meta (WhatsApp Business Platform)</strong> — delivers messages between you and us.</li>
  <li><strong>Razorpay</strong> and/or <strong>WhatsApp Pay</strong> payment partners — process online payments.</li>
  <li><strong>OpenAI</strong> — the text of your messages may be processed to understand requests and draft replies.</li>
  <li><strong>OpenStreetMap Nominatim</strong> — place names from Maps links you send may be looked up to find a location.</li>
  <li>Our hosting and database providers, which store the data securely.</li>
</ul>

<h2>How long we keep it</h2>
<p>We keep order and message records while you are a customer and as long as needed for accounting and legal obligations. Temporary chat state expires after 30 minutes and technical delivery logs after 30 days.</p>

<h2>Your choices</h2>
<p>You can ask us to see, correct or delete your data at any time. Deleting your data does not affect orders already completed, which we may need to keep for legal reasons. You can stop messages from us by blocking our number in WhatsApp.</p>

<h2>Contact</h2>
<p>${name}, ${esc(clean(kb.address))}<br>
Email: <a href="mailto:${email}">${email}</a> · Phone: ${esc(clean(kb.contactPhone))}</p>
</main>`;

  return layout({ kb, title: `Privacy policy — ${clean(kb.name)}`, description: `How ${clean(kb.name)} handles your data.`, body });
};

const notFoundPage = (kb) =>
  layout({
    kb,
    title: `Page not found — ${clean(kb.name)}`,
    description: 'Page not found.',
    body: `<main class="wrap prose center"><h1>Page not found</h1><p><a href="/">Back to home</a></p></main>`,
  });

// ---------------------------------------------------------------------------
// 4. Build
// ---------------------------------------------------------------------------

/**
 * Writes the site into outDir (emptied first).
 * @param {object} [options]
 * @param {object} [options.kb] business knowledge (default: config)
 * @param {string} [options.outDir]
 * @param {string} [options.publicDir] static assets to copy
 * @param {boolean} [options.allowPlaceholders] build even with [EDIT] values (preview only)
 * @returns {{ outDir: string, files: string[], problems: string[] }}
 */
const buildSite = ({ kb = businessKnowledge, outDir = DEFAULT_OUT_DIR, publicDir = PUBLIC_DIR, allowPlaceholders = false } = {}) => {
  const problems = findProblems(kb);
  if (problems.length && !allowPlaceholders) {
    const err = new Error(`Fix src/config/businessKnowledge.js before publishing:\n- ${problems.join('\n- ')}`);
    err.problems = problems;
    throw err;
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(publicDir)) fs.cpSync(publicDir, outDir, { recursive: true });

  const hasQr = fs.existsSync(path.join(outDir, QR_FILE));
  const pages = {
    'index.html': homePage(kb, { hasQr }),
    'privacy.html': privacyPage(kb),
    '404.html': notFoundPage(kb),
  };
  Object.entries(pages).forEach(([file, html]) => fs.writeFileSync(path.join(outDir, file), html));

  return { outDir, files: fs.readdirSync(outDir).sort(), problems };
};

module.exports = { buildSite, findProblems, whatsappLink };

if (require.main === module) {
  try {
    const allowPlaceholders = process.env.SITE_ALLOW_PLACEHOLDERS === 'true';
    const { outDir, files, problems } = buildSite({ allowPlaceholders });
    problems.forEach((p) => console.warn(`[site] WARNING: ${p}`));
    console.log(`[site] Built ${files.length} files into ${path.relative(ROOT, outDir)}: ${files.join(', ')}`);
  } catch (err) {
    console.error(`[site] ${err.message}`);
    process.exit(1);
  }
}
