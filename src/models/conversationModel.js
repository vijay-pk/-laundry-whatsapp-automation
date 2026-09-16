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
// (not a hand-off to staff) and was sent within ANSWER_WINDOW_MINUTES.
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
      SELECT o.content, o.intent, o.created_at
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
      AND a.intent IN ('question', 'greeting')
      AND a.created_at <= q.created_at + ($3 || ' minutes')::interval
    ORDER BY rank DESC, q.created_at DESC
    LIMIT $2
  `;

  const { rows } = await query(sql, [tsQuery, limit, String(ANSWER_WINDOW_MINUTES)]);
  return rows;
};

module.exports = {
  getRecentConversation,
  findSimilarPastAnswers,
};
