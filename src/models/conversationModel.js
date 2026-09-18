/**
 * src/models/conversationModel.js
 * Reads the message log to give the AI context:
 * - recent conversation with one client
 * - past answers to similar questions (how the assistant "learns")
 */

const { query } = require('../config/db');

// Only reuse replies sent within this long after the question.
const ANSWER_WINDOW_MINUTES = 10;

// Max words taken from a question when searching past answers.
const MAX_SEARCH_WORDS = 12;

// Outbound intents that count as AI answers (menus, flows, payments, hand-offs never do).
const ANSWER_INTENTS = ['question', 'greeting'];

// Only staff-approved answers are reused, unless AI_LEARNING_REQUIRE_APPROVAL=false.
const requireApproval = () => process.env.AI_LEARNING_REQUIRE_APPROVAL !== 'false';

// ---------------------------------------------------------------------------
// getRecentConversation
// Last `limit` messages with this client, oldest first.
// ---------------------------------------------------------------------------
const getRecentConversation = async (clientPhone, limit = 10) => {
  if (!clientPhone) return [];

  const sql = `
    SELECT direction, content, intent, created_at
    FROM (
      SELECT direction, content, intent, created_at
      FROM messages
      WHERE client_phone = $1
      ORDER BY created_at DESC
      LIMIT $2
    ) recent
    ORDER BY created_at ASC
  `;

  const { rows } = await query(sql, [clientPhone, limit]);
  return rows;
};

// ---------------------------------------------------------------------------
// findSimilarPastAnswers
// Full-text search over past inbound questions (any client). For each match,
// takes the very next outbound reply to that client, if it was an AI answer
// (not a hand-off to staff), was sent within ANSWER_WINDOW_MINUTES and was approved by staff
// (admin dashboard "AI Answers"), so one customer can't teach the assistant wrong facts.
// Returns [{ question, answer, rank }] best match first.
// ---------------------------------------------------------------------------
const findSimilarPastAnswers = async (text, limit = 5) => {
  // Build an OR query from plain words ("how much ironing" -> "how | much | ironing").
  // Only [a-z0-9] survive, so the tsquery string can't be malformed.
  const words = String(text ?? '')
    .toLowerCase()
    .match(/[a-z0-9]{2,}/g);
  if (!words || words.length === 0) return [];

  const tsQuery = [...new Set(words)].slice(0, MAX_SEARCH_WORDS).join(' | ');

  const sql = `
    SELECT q.content AS question,
           a.content AS answer,
           ts_rank(to_tsvector('english', q.content), to_tsquery('english', $1)) AS rank
    FROM messages q
    JOIN LATERAL (
      SELECT o.content, o.intent, o.created_at, o.approved_at
      FROM messages o
      WHERE o.client_phone = q.client_phone
        AND o.direction = 'outbound'
        AND o.created_at > q.created_at
      ORDER BY o.created_at ASC
      LIMIT 1
    ) a ON TRUE
    WHERE q.direction = 'inbound'
      AND q.intent = 'question'
      AND q.client_phone IS NOT NULL
      AND to_tsvector('english', q.content) @@ to_tsquery('english', $1)
      AND a.intent = ANY($4::text[])
      AND a.created_at <= q.created_at + ($3 || ' minutes')::interval
      AND ($5::boolean IS FALSE OR a.approved_at IS NOT NULL)
    ORDER BY rank DESC, q.created_at DESC
    LIMIT $2
  `;

  const { rows } = await query(sql, [tsQuery, limit, String(ANSWER_WINDOW_MINUTES), ANSWER_INTENTS, requireApproval()]);
  return rows;
};

// ---------------------------------------------------------------------------
// AI answer review (admin dashboard)
// ---------------------------------------------------------------------------

/**
 * Recent AI answers with the customer message they replied to; unapproved first.
 * @returns {Promise<Array<{id, question, answer, client_phone, created_at, approved_at}>>}
 */
const listAiAnswers = async (limit = 100) => {
  const { rows } = await query(
    `SELECT a.id, a.content AS answer, a.client_phone, a.created_at, a.approved_at, q.content AS question
     FROM messages a
     LEFT JOIN LATERAL (
       SELECT content FROM messages q
       WHERE q.client_phone = a.client_phone AND q.direction = 'inbound' AND q.created_at <= a.created_at
       ORDER BY q.created_at DESC LIMIT 1
     ) q ON TRUE
     WHERE a.direction = 'outbound' AND a.intent = ANY($1::text[])
     ORDER BY (a.approved_at IS NOT NULL), a.created_at DESC
     LIMIT $2`,
    [ANSWER_INTENTS, Math.min(Math.max(Number(limit) || 1, 1), 500)]
  );
  return rows;
};

/**
 * Approve (reuse for other customers) or withdraw approval of an AI answer.
 * @returns {Promise<object|null>} updated message, or null if it isn't an AI answer
 */
const setAnswerApproval = async (messageId, adminId, approved) => {
  const { rows } = await query(
    `UPDATE messages
     SET approved_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
         approved_by = CASE WHEN $3 THEN $2::uuid ELSE NULL END
     WHERE id = $1 AND direction = 'outbound' AND intent = ANY($4::text[])
     RETURNING id, approved_at`,
    [messageId, adminId, Boolean(approved), ANSWER_INTENTS]
  );
  return rows[0] || null;
};

module.exports = {
  getRecentConversation,
  findSimilarPastAnswers,
  listAiAnswers,
  setAnswerApproval,
};
