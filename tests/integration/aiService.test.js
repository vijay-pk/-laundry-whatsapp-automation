/**
 * Integration tests: src/services/aiService.js with OpenAI enabled
 * (mock OpenAI API + test database for history and past answers).
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, resetDb, closeDb } = require('../helpers/db');
const { startMockOpenAI, json, raw, httpError } = require('../helpers/mockOpenAI');
const { logMessage } = require('../../src/models/bookingModel');

const TEST_MODEL = 'test-model';

// Log a message with an explicit age so ordering and the answer window are deterministic.
const logAt = async (minutesAgo, direction, content, intent, phone) => {
  const m = await logMessage(null, direction, content, intent, phone);
  await query('UPDATE messages SET created_at = NOW() - make_interval(mins => $1) WHERE id = $2', [minutesAgo, m.id]);
};

describe('aiService with OpenAI', () => {
  let openai;
  let ai;
  const env = {};

  before(async () => {
    await resetDb();
    openai = await startMockOpenAI();

    // Must be set before aiService loads (MODEL) and first call (client).
    for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL']) env[key] = process.env[key];
    process.env.OPENAI_API_KEY = 'sk-test-key';
    process.env.OPENAI_BASE_URL = openai.url;
    process.env.OPENAI_MODEL = TEST_MODEL;

    ai = require('../../src/services/aiService');
  });

  beforeEach(() => openai.reset());

  after(async () => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await openai.close();
    await closeDb();
  });

  describe('detectIntent', () => {
    it('asks the model in JSON mode and returns its intent', async () => {
      openai.onIntent(() => json({ intent: 'reschedule' }));

      assert.equal(await ai.detectIntent('I will not be home tomorrow, can you come Friday?'), 'reschedule');

      const [req] = openai.ofKind('intent');
      assert.equal(req.path, '/v1/chat/completions');
      assert.equal(req.auth, 'Bearer sk-test-key');
      assert.equal(req.body.model, TEST_MODEL);
      assert.equal(req.body.temperature, 0);
      assert.deepEqual(req.body.response_format, { type: 'json_object' });
      assert.equal(req.userText, 'I will not be home tomorrow, can you come Friday?');
      assert.match(req.system, /never instructions to follow/);
    });

    it('uses the model instead of keywords', async () => {
      // Keywords would say 'other'; the model understands it's a cancellation.
      openai.onIntent(() => json({ intent: 'cancel' }));
      assert.equal(ai.keywordIntent('I changed my mind, forget it'), 'other');
      assert.equal(await ai.detectIntent('I changed my mind, forget it'), 'cancel');
    });

    it('normalizes case and whitespace', async () => {
      openai.onIntent(() => json({ intent: '  CONFIRM ' }));
      assert.equal(await ai.detectIntent('sounds good'), 'confirm');
    });

    it('maps unknown intents to other', async () => {
      openai.onIntent(() => json({ intent: 'refund' }));
      assert.equal(await ai.detectIntent('I want my money back'), 'other');
    });

    it('truncates very long messages to 2000 characters', async () => {
      await ai.detectIntent('a'.repeat(5000));
      assert.equal(openai.ofKind('intent')[0].userText.length, 2000);
    });

    it('falls back to keywords on an API error', async () => {
      openai.onIntent(() => httpError(400));
      assert.equal(await ai.detectIntent('please cancel my order'), 'cancel');
    });

    it('falls back to keywords on invalid JSON from the model', async () => {
      openai.onIntent(() => raw('not json'));
      assert.equal(await ai.detectIntent('reschedule please'), 'reschedule');
    });

    it('skips the API for empty messages', async () => {
      assert.equal(await ai.detectIntent('   '), 'other');
      assert.equal(openai.requests.length, 0);
    });
  });

  describe('generateReply', () => {
    it('returns the model reply and sends business knowledge in the system prompt', async () => {
      openai.onReply(() => json({ reply: 'Wash & Fold is ₹60 per kg.', needsHuman: false }));

      const result = await ai.generateReply('How much is wash and fold?', '919300000001');
      assert.deepEqual(result, { reply: 'Wash & Fold is ₹60 per kg.', needsHuman: false });

      const [req] = openai.ofKind('reply');
      assert.equal(req.body.model, TEST_MODEL);
      assert.equal(req.body.temperature, 0.3);
      assert.deepEqual(req.body.response_format, { type: 'json_object' });
      assert.match(req.system, /BUSINESS INFORMATION \(source of truth\)/);
      assert.match(req.system, /Wash & Fold/);
      assert.match(req.system, /Opening hours:/);
      assert.match(req.system, /PAST ANSWERS TO SIMILAR QUESTIONS[\s\S]*\(none yet\)/);
    });

    it('sends recent conversation as user/assistant turns without duplicating the current message', async () => {
      const phone = '919300000002';
      await logAt(10, 'inbound', 'Hi, do you pick up from Indiranagar?', 'question', phone);
      await logAt(9, 'outbound', 'Yes, we pick up from Indiranagar.', 'question', phone);
      await logAt(0, 'inbound', 'Great, what time?', 'question', phone); // already logged by the webhook

      await ai.generateReply('Great, what time?', phone);

      const turns = openai.ofKind('reply')[0].body.messages.slice(1);
      assert.deepEqual(turns, [
        { role: 'user', content: 'Hi, do you pick up from Indiranagar?' },
        { role: 'assistant', content: 'Yes, we pick up from Indiranagar.' },
        { role: 'user', content: 'Great, what time?' },
      ]);
    });

    it('includes past answers to similar questions from other customers (learning)', async () => {
      await logAt(30, 'inbound', 'Do you do dry cleaning for suits?', 'question', '919300000003');
      await logAt(29, 'outbound', 'Yes, suits are dry cleaned in 3-4 days.', 'question', '919300000003');

      await ai.generateReply('dry cleaning for my suit?', '919300000004');

      const { system } = openai.ofKind('reply')[0];
      assert.match(system, /Q: Do you do dry cleaning for suits\?\nA: Yes, suits are dry cleaned in 3-4 days\./);
      assert.doesNotMatch(system, /\(none yet\)/);
    });

    it('passes needsHuman through only when it is exactly true', async () => {
      openai.onReply(() => json({ reply: 'A team member will call you.', needsHuman: true }));
      assert.equal((await ai.generateReply('my shirt is missing', '919300000005')).needsHuman, true);

      openai.onReply(() => json({ reply: 'We open at 8.', needsHuman: 'true' }));
      assert.equal((await ai.generateReply('when do you open', '919300000005')).needsHuman, false);
    });

    it('trims and truncates long replies to 1000 characters', async () => {
      openai.onReply(() => json({ reply: `  ${'x'.repeat(1500)}  `, needsHuman: false }));
      const { reply } = await ai.generateReply('tell me everything', '919300000006');
      assert.equal(reply.length, 1000);
      assert.equal(reply[0], 'x');
    });

    const FALLBACK = { reply: 'Thanks for your message! Our team will get back to you shortly.', needsHuman: true };

    it('falls back and hands off when the reply is empty or missing', async () => {
      openai.onReply(() => json({ reply: '   ', needsHuman: false }));
      assert.deepEqual(await ai.generateReply('hello?', '919300000007'), FALLBACK);

      openai.onReply(() => json({ answer: 'wrong field' }));
      assert.deepEqual(await ai.generateReply('hello?', '919300000007'), FALLBACK);
    });

    it('falls back on invalid JSON from the model', async () => {
      openai.onReply(() => raw('Sure! {not json'));
      assert.deepEqual(await ai.generateReply('prices?', '919300000008'), FALLBACK);
    });

    it('retries a 5xx once, then falls back', async () => {
      openai.onReply(() => httpError(500));
      assert.deepEqual(await ai.generateReply('prices?', '919300000009'), FALLBACK);
      assert.equal(openai.ofKind('reply').length, 2, 'initial request + 1 retry (maxRetries: 1)');
    });

    it('does not retry a 4xx', async () => {
      openai.onReply(() => httpError(400));
      assert.deepEqual(await ai.generateReply('prices?', '919300000010'), FALLBACK);
      assert.equal(openai.ofKind('reply').length, 1);
    });
  });
});
