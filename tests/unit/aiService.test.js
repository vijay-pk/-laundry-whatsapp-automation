/**
 * Unit tests: src/services/aiService.js without OpenAI (no network, no database queries)
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// Force the no-API-key path before the module reads it.
process.env.OPENAI_API_KEY = '';
process.env.GROQ_API_KEY = '';

const { aiConfig, keywordIntent, detectIntent, generateReply } = require('../../src/services/aiService');

describe('keywordIntent', () => {
  const cases = [
    ['cancel my pickup', 'cancel'],
    ['Please CANCEL the booking', 'cancel'],
    ['Can I reschedule to friday', 'reschedule'],
    ['need to change the time', 'reschedule'],
    ['postpone to next week', 'reschedule'],
    ['yes', 'confirm'],
    ['Ok see you', 'confirm'],
    ['confirmed', 'confirm'],
    ['hi', 'greeting'],
    ['Good morning', 'greeting'],
    ['how much for ironing?', 'question'],
    ['what are your timings', 'question'],
    ['do you deliver to my area', 'question'],
    ['thanks bro', 'other'],
    ['book a pickup', 'book'],
    ['I need a pickup tomorrow', 'book'],
    ['I want to place an order', 'book'],
    ['where is my laundry', 'status'],
    ['track my order', 'status'],
    ['is my clothes ready', 'status'],
  ];

  for (const [text, expected] of cases) {
    it(`"${text}" -> ${expected}`, () => {
      assert.equal(keywordIntent(text), expected);
    });
  }

  it('prefers cancel over reschedule when both appear', () => {
    assert.equal(keywordIntent('cancel or reschedule?'), 'cancel');
  });
});

describe('without OPENAI_API_KEY', () => {
  before(() => {
    // Silence the one-time "key not set" warning
    const warn = console.warn;
    console.warn = () => {};
    return detectIntent('hi').finally(() => { console.warn = warn; });
  });

  it('detectIntent falls back to keywords', async () => {
    assert.equal(await detectIntent('please cancel'), 'cancel');
  });

  it('detectIntent returns other for empty input', async () => {
    assert.equal(await detectIntent('   '), 'other');
    assert.equal(await detectIntent(null), 'other');
  });

  it('generateReply returns fallback reply and hands off to a human', async () => {
    const result = await generateReply('what are your prices?', '919999999999');
    assert.equal(result.needsHuman, true);
    assert.match(result.reply, /team will get back/i);
  });
});

describe('aiConfig (provider from env)', () => {
  it('uses OpenAI for an sk- key', () => {
    assert.deepEqual(aiConfig({ OPENAI_API_KEY: 'sk-abc', OPENAI_MODEL: 'gpt-4o' }), { provider: 'openai', apiKey: 'sk-abc', model: 'gpt-4o' });
  });

  it('uses Groq for GROQ_API_KEY, with its own model default', () => {
    assert.deepEqual(aiConfig({ GROQ_API_KEY: 'gsk_abc', OPENAI_MODEL: 'gpt-4o-mini' }), {
      provider: 'groq', apiKey: 'gsk_abc', baseURL: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b',
    });
    assert.equal(aiConfig({ GROQ_API_KEY: 'gsk_abc', GROQ_MODEL: 'llama-3.3-70b-versatile' }).model, 'llama-3.3-70b-versatile');
  });

  it('sends a Groq key pasted into OPENAI_API_KEY to Groq, not OpenAI', () => {
    const config = aiConfig({ OPENAI_API_KEY: 'gsk_pasted' });
    assert.equal(config.provider, 'groq');
    assert.equal(config.baseURL, 'https://api.groq.com/openai/v1');
  });

  it('is null without a usable key', () => {
    assert.equal(aiConfig({}), null);
    assert.equal(aiConfig({ OPENAI_API_KEY: 'sk-replace-me' }), null);
  });
});
