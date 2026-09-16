/**
 * Integration tests: src/models/conversationModel.js (AI context + self-learning)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, resetDb, closeDb } = require('../helpers/db');
const { logMessage } = require('../../src/models/bookingModel');
const convo = require('../../src/models/conversationModel');

// Insert a message with an explicit timestamp offset (minutes ago).
const logAt = async (minutesAgo, direction, content, intent, phone) => {
  const m = await logMessage(null, direction, content, intent, phone);
  await query(`UPDATE messages SET created_at = NOW() - make_interval(mins => $1) WHERE id = $2`, [minutesAgo, m.id]);
};

describe('conversationModel', () => {
  before(async () => {
    await resetDb();

    // Customer A: question answered by the AI -> learnable
    await logAt(60, 'inbound', 'How much does dry cleaning cost?', 'question', '919100000001');
    await logAt(59, 'outbound', 'Dry cleaning starts from 150 per piece.', 'question', '919100000001');

    // Customer B: question handed off to staff -> must not be learned
    await logAt(50, 'inbound', 'What is the dry cleaning price for a saree?', 'question', '919100000002');
    await logAt(49, 'outbound', 'A team member will follow up.', 'handoff', '919100000002');

    // Customer C: reply came much later than the answer window -> must not be learned
    await logAt(300, 'inbound', 'Do you offer dry cleaning for curtains?', 'question', '919100000003');
    await logAt(200, 'outbound', 'Yes we do.', 'question', '919100000003');

    // Customer D: next message is another inbound, then a reply -> pairs with the reply
    await logAt(40, 'inbound', 'What are your opening hours?', 'question', '919100000004');
    await logAt(39, 'inbound', 'hello?', 'greeting', '919100000004');
    await logAt(38, 'outbound', 'We are open 8 AM to 8 PM.', 'question', '919100000004');
  });
  after(closeDb);

  describe('getRecentConversation', () => {
    it('returns the latest N messages, oldest first', async () => {
      const history = await convo.getRecentConversation('919100000004', 2);
      assert.deepEqual(
        history.map((m) => m.content),
        ['hello?', 'We are open 8 AM to 8 PM.']
      );
    });

    it('returns [] for no phone or unknown client', async () => {
      assert.deepEqual(await convo.getRecentConversation(null), []);
      assert.deepEqual(await convo.getRecentConversation('919999999999'), []);
    });
  });

  describe('findSimilarPastAnswers', () => {
    it('learns answered questions and skips hand-offs and late replies', async () => {
      const results = await convo.findSimilarPastAnswers('dry cleaning price please');
      assert.equal(results.length, 1);
      assert.equal(results[0].question, 'How much does dry cleaning cost?');
      assert.match(results[0].answer, /150/);
    });

    it('pairs a question with the next outbound reply, not the next inbound message', async () => {
      const results = await convo.findSimilarPastAnswers('opening hours');
      assert.equal(results.length, 1);
      assert.equal(results[0].answer, 'We are open 8 AM to 8 PM.');
    });

    it('returns [] when nothing matches', async () => {
      assert.deepEqual(await convo.findSimilarPastAnswers('bicycle repair'), []);
    });

    it('handles punctuation-only and hostile input safely', async () => {
      assert.deepEqual(await convo.findSimilarPastAnswers('?? !!'), []);
      assert.deepEqual(await convo.findSimilarPastAnswers(''), []);
      assert.ok(Array.isArray(await convo.findSimilarPastAnswers("'); DROP TABLE messages; -- & | ! :*")));
      assert.ok((await query('SELECT COUNT(*) FROM messages')).rows[0].count > 0);
    });

    it('respects the limit', async () => {
      const results = await convo.findSimilarPastAnswers('dry cleaning opening hours price', 1);
      assert.equal(results.length, 1);
    });
  });
});
