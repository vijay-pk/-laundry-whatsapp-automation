/**
 * src/views/html.js
 * Minimal server-side HTML helpers: escaping, page layout, security headers.
 * Every dynamic value in a page must go through esc().
 */

const crypto = require('crypto');

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const newNonce = () => crypto.randomBytes(16).toString('base64');

const BASE_CSS = `
  :root { --bg:#f5f7fb; --card:#fff; --text:#1d2433; --muted:#667085; --line:#e4e7ec; --brand:#1b6ef3;
          --ok:#0f9d58; --warn:#b54708; --bad:#d92d20; --info:#175cd3; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); }
  main { max-width: 1100px; margin: 0 auto; padding: 16px; }
  .narrow { max-width: 480px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px; }
  h1 { font-size:1.35rem; margin:0 0 12px; } h2 { font-size:1.1rem; margin:0 0 12px; }
  .muted { color:var(--muted); } .small { font-size:.85rem; } .center { text-align:center; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--line); }
  .row:last-child { border-bottom:0; } .row b { text-align:right; }
  .btn { display:inline-block; width:100%; padding:14px; border:0; border-radius:10px; background:var(--brand); color:#fff;
         font-size:1rem; font-weight:600; cursor:pointer; text-align:center; text-decoration:none; }
  .btn:disabled { opacity:.6; cursor:wait; } .btn.secondary { background:#eef2f6; color:var(--text); }
  .btn.small { width:auto; padding:8px 12px; font-size:.85rem; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:.78rem; font-weight:600; background:#eef2f6; white-space:nowrap; }
  .badge.ok { background:#e7f6ee; color:var(--ok); } .badge.warn { background:#fff4e5; color:var(--warn); }
  .badge.bad { background:#fdecea; color:var(--bad); } .badge.info { background:#eaf2ff; color:var(--info); }
  .notice { padding:12px; border-radius:10px; margin-bottom:12px; } .notice.ok { background:#e7f6ee; }
  .notice.bad { background:#fdecea; } .notice.warn { background:#fff4e5; }
  label { display:block; font-weight:600; margin:14px 0 6px; }
  input[type=email], input[type=password], input[type=number] { width:100%; padding:10px; border:1px solid var(--line); border-radius:8px; font-size:1rem; }
  .choice { display:flex; gap:8px; align-items:center; font-weight:400; margin:6px 0; }
  nav { background:#101828; color:#fff; } nav .inner { max-width:1100px; margin:0 auto; padding:10px 16px; display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
  nav a { color:#fff; text-decoration:none; } nav .spacer { flex:1; } nav form { margin:0; }
  table { width:100%; border-collapse:collapse; font-size:.88rem; } th, td { text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; white-space:nowrap; } code { font-size:.78rem; word-break:break-all; }
  @media (max-width: 760px) {
    table, thead, tbody, tr, td { display:block; } thead { display:none; }
    tr { background:var(--card); border:1px solid var(--line); border-radius:10px; margin-bottom:10px; padding:6px 10px; }
    td { border:0; padding:4px 0; display:flex; justify-content:space-between; gap:10px; }
    td::before { content: attr(data-label); color:var(--muted); font-weight:600; }
  }
`;

/**
 * Full HTML document.
 * @param {{title: string, body: string, nonce: string, head?: string, nav?: string}} options
 */
const page = ({ title, body, nonce, head = '', nav = '' }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style nonce="${nonce}">${BASE_CSS}</style>
${head}
</head>
<body>
${nav}
${body}
</body>
</html>`;

/**
 * Security headers for server-rendered pages.
 * @param {object} res  express response
 * @param {string} nonce  script/style nonce
 * @param {{razorpay?: boolean}} options  allow Razorpay Checkout on this page
 */
const setPageHeaders = (res, nonce, { razorpay = false } = {}) => {
  const csp = [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'${razorpay ? ' https://checkout.razorpay.com' : ''}`,
    // Razorpay Checkout injects inline styles, and 'unsafe-inline' is ignored when a nonce is present.
    razorpay ? "style-src 'self' 'unsafe-inline'" : `style-src 'nonce-${nonce}'`,
    `connect-src 'self'${razorpay ? ' https://*.razorpay.com' : ''}`,
    `frame-src ${razorpay ? 'https://api.razorpay.com https://checkout.razorpay.com' : "'none'"}`,
    `img-src 'self' data:${razorpay ? ' https://*.razorpay.com' : ''}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  res.set({
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', // payment links contain a secret token
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
  });
};

module.exports = { esc, newNonce, page, setPageHeaders };
