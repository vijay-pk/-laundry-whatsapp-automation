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

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });

      res.setHeader('Content-Type', 'application/json');

      if (failNext > 0) {
        failNext -= 1;
        res.statusCode = 400;
        return res.end(JSON.stringify({
          error: { message: 'Mock failure', code: 131047, error_subcode: 0, fbtrace_id: 'mock' },
        }));
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
    failNextRequests: (n = 1) => {
      failNext = n;
    },
    reset: () => {
      requests.length = 0;
      failNext = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

module.exports = { startMockGraph };
