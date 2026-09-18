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

    // Customer E: answered but never approved by staff -> must not be learned
    await logAt(20, 'inbound', 'Do you iron silk sarees?', 'question', '919100000005');
    await logAt(19, 'outbound', 'Silk ironing is free today!', 'question', '919100000005');

    // Staff approved every answer except customer E's
    await query(`UPDATE messages SET approved_at = NOW() WHERE direction = 'outbound' AND client_phone <> '919100000005'`);
  });
  after(closeDb);

  describe('AI answer review', () => {
    it('lists answers with their question, unapproved first, and toggles approval', async () => {
      const answers = await convo.listAiAnswers();
      assert.equal(answers[0].answer, 'Silk ironing is free today!');
      assert.equal(answers[0].question, 'Do you iron silk sarees?');
      assert.equal(answers[0].approved_at, null);
      assert.ok(answers.every((a) => a.answer !== 'A team member will follow up.'), 'hand-offs are not AI answers');

      const { rows: [admin] } = await query(
        `INSERT INTO admin_users (email, password_hash, role) VALUES ('review@laundry.test', 'x', 'super_admin') RETURNING id`
      );
      assert.ok((await convo.setAnswerApproval(answers[0].id, admin.id, true)).approved_at);
      assert.equal((await convo.setAnswerApproval(answers[0].id, admin.id, false)).approved_at, null);

      const { rows: [handoff] } = await query(`SELECT id FROM messages WHERE intent = 'handoff' LIMIT 1`);
      assert.equal(await convo.setAnswerApproval(handoff.id, admin.id, true), null, 'only AI answers can be approved');
    });
  });

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

    it('never reuses answers staff have not approved (unless approval is switched off)', async () => {
      assert.deepEqual(await convo.findSimilarPastAnswers('iron silk sarees'), []);

      process.env.AI_LEARNING_REQUIRE_APPROVAL = 'false';
      try {
        const results = await convo.findSimilarPastAnswers('iron silk sarees');
        assert.equal(results.length, 1);
      } finally {
        delete process.env.AI_LEARNING_REQUIRE_APPROVAL;
      }
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
