/**
 * tests/helpers/mockGraph.js
 * Local stand-in for the Meta Graph API. The server under test points
 * WHATSAPP_API_BASE_URL here, so tests can see every outbound WhatsApp
 * message and simulate API failures without network access.
 */

const http = require('http');

const startMockGraph = async () => {
  const requests = [];
  let failNext = 0; // number of upcoming requests to reject
  let failOrderDetails = 0; // upcoming order_details (WhatsApp Pay) messages to reject
  const paymentLookups = new Map(); // WhatsApp Pay reference_id -> payments[] for the lookup API

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });

      res.setHeader('Content-Type', 'application/json');

      if (failOrderDetails > 0 && body?.interactive?.type === 'order_details') {
        failOrderDetails -= 1;
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: 'Payments not enabled', code: 131009, fbtrace_id: 'mock' } }));
      }

      if (failNext > 0) {
        failNext -= 1;
        res.statusCode = 400;
        return res.end(JSON.stringify({
          error: { message: 'Mock failure', code: 131047, error_subcode: 0, fbtrace_id: 'mock' },
        }));
      }

      // WhatsApp Pay lookup: GET /<PHONE_NUMBER_ID>/payments/<configuration>/<reference_id>
      const lookup = req.method === 'GET' && req.url.match(/^\/[^/]+\/payments\/[^/]+\/([^/?]+)/);
      if (lookup) {
        res.statusCode = 200;
        return res.end(JSON.stringify({ payments: paymentLookups.get(decodeURIComponent(lookup[1])) || [] }));
      }

      res.statusCode = 200;
      return res.end(JSON.stringify({
        messaging_product: 'whatsapp',
        contacts: [{ input: body?.to, wa_id: body?.to }],
        messages: [{ id: `wamid.mock.${requests.length}` }],
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  return {
    url: `http://localhost:${port}`,
    requests,
    // Messages sent to a given phone (digits only)
    sentTo: (phone) => requests.filter((r) => r.body?.to === phone),
    // Order details (WhatsApp Pay) messages sent to a phone
    orderDetailsTo: (phone) => requests.filter((r) => r.body?.to === phone && r.body?.interactive?.type === 'order_details'),
    setPaymentLookup: (referenceId, payments) => paymentLookups.set(referenceId, payments),
    failNextOrderDetails: (n = 1) => {
      failOrderDetails = n;
    },
    failNextRequests: (n = 1) => {
      failNext = n;
    },
    reset: () => {
      requests.length = 0;
      failNext = 0;
      paymentLookups.clear();
      failOrderDetails = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

module.exports = { startMockGraph };
