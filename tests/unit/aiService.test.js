/**
 * Unit tests: src/services/aiService.js without OpenAI (no network, no database queries)
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// Force the no-API-key path before the module reads it.
process.env.OPENAI_API_KEY = '';

const { keywordIntent, detectIntent, generateReply } = require('../../src/services/aiService');

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
