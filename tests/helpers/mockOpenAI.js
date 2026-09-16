/**
 * tests/helpers/mockOpenAI.js
 * Local stand-in for the OpenAI Chat Completions API.
 * The OpenAI SDK reads OPENAI_BASE_URL, so pointing it here needs no app changes.
 *
 * Requests are classified by their system prompt:
 *   'intent' -> aiService.detectIntent
 *   'reply'  -> aiService.generateReply
 *
 * Handlers receive { body, messages, system, userText } and return one of:
 *   json({...})        valid completion whose content is that object as JSON
 *   raw('text')        completion with arbitrary (possibly invalid) content
 *   httpError(status)  API error response
 */

const http = require('http');

const json = (value) => ({ content: JSON.stringify(value) });
const raw = (content) => ({ content });
const httpError = (status = 500, message = 'Mock OpenAI error') => ({ status, message });

const DEFAULT_HANDLERS = {
  intent: () => json({ intent: 'question' }),
  reply: () => json({ reply: 'Mock reply', needsHuman: false }),
};

const startMockOpenAI = async () => {
  const requests = [];
  const handlers = { ...DEFAULT_HANDLERS };

  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      const messages = body.messages || [];
      const system = messages.find((m) => m.role === 'system')?.content || '';
      const userText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
      const kind = system.startsWith('You classify') ? 'intent' : 'reply';

      requests.push({ kind, path: req.url, auth: req.headers.authorization, body, system, userText });

      const result = handlers[kind]({ body, messages, system, userText });
      res.setHeader('Content-Type', 'application/json');

      if (result.status) {
        res.statusCode = result.status;
        return res.end(JSON.stringify({ error: { message: result.message, type: 'mock_error', code: null } }));
      }

      res.statusCode = 200;
      return res.end(JSON.stringify({
        id: `chatcmpl-mock-${requests.length}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  return {
    url: `http://localhost:${port}/v1`,
    requests,
    ofKind: (kind) => requests.filter((r) => r.kind === kind),
    onIntent: (fn) => {
      handlers.intent = fn;
    },
    onReply: (fn) => {
      handlers.reply = fn;
    },
    reset: () => {
      requests.length = 0;
      Object.assign(handlers, DEFAULT_HANDLERS);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

module.exports = { startMockOpenAI, json, raw, httpError };
