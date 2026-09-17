/**
 * End-to-end tests: WhatsApp messages answered by the AI
 * (real server + test database + mock Graph API + mock OpenAI).
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, resetDb, createBusiness, closeDb } = require('../helpers/db');
const { startMockGraph } = require('../helpers/mockGraph');
const { startMockOpenAI, json, httpError } = require('../helpers/mockOpenAI');
const { TEST_ENV, startServer, webhookPayload, textMessage, tapMessage, waitFor } = require('../helpers/server');
const { createBooking } = require('../../src/models/bookingModel');

const waitForDone = (id) =>
  waitFor(async () => {
    const { rows } = await query('SELECT status FROM webhook_events WHERE wa_message_id = $1', [id]);
    return ['done', 'failed'].includes(rows[0]?.status) ? rows[0] : null;
  });

const outboundLog = async (phone) =>
  (await query(
    `SELECT content, intent FROM messages WHERE client_phone = $1 AND direction = 'outbound' ORDER BY created_at`,
    [phone]
  )).rows;

const adminMessagesAbout = (graph, phone) =>
  graph.sentTo(TEST_ENV.ADMIN_PHONE).filter((r) => r.body.text?.body.includes(phone));

describe('WhatsApp AI replies (end-to-end)', () => {
  let graph;
  let openai;
  let server;
  let business;

  before(async () => {
    await resetDb();
    business = await createBusiness();
    graph = await startMockGraph();
    openai = await startMockOpenAI();
    server = await startServer({
      graphUrl: graph.url,
      env: { OPENAI_API_KEY: 'sk-test-key', OPENAI_BASE_URL: openai.url, OPENAI_MODEL: 'test-model' },
    });
  });

  beforeEach(() => openai.reset());

  after(async () => {
    await server?.stop();
    await openai?.close();
    await graph?.close();
    await closeDb();
  });

  it('answers a question with the AI reply', async () => {
    const phone = '919400000001';
    openai.onIntent(() => json({ intent: 'question' }));
    openai.onReply(() => json({ reply: 'Ironing is ₹15 per piece, ready in 24 hours.', needsHuman: false }));

    await server.postWebhook(webhookPayload([textMessage('wamid.ai.q1', phone, 'how much for ironing?')]));
    assert.equal((await waitForDone('wamid.ai.q1')).status, 'done');

    const sent = graph.sentTo(phone);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.type, 'text');
    assert.equal(sent[0].body.text.body, 'Ironing is ₹15 per piece, ready in 24 hours.');

    assert.deepEqual(await outboundLog(phone), [
      { content: 'Ironing is ₹15 per piece, ready in 24 hours.', intent: 'question' },
    ]);
    assert.equal(adminMessagesAbout(graph, phone).length, 0, 'no hand-off');
  });

  it('hands off to the admin when the AI needs a human', async () => {
    const phone = '919400000002';
    openai.onIntent(() => json({ intent: 'question' }));
    openai.onReply(() => json({ reply: 'Sorry about that! A team member will contact you shortly.', needsHuman: true }));

    await server.postWebhook(webhookPayload([textMessage('wamid.ai.handoff', phone, 'my blue shirt is missing')]));
    assert.equal((await waitForDone('wamid.ai.handoff')).status, 'done');

    assert.equal(graph.sentTo(phone)[0].body.text.body, 'Sorry about that! A team member will contact you shortly.');

    const admin = adminMessagesAbout(graph, phone);
    assert.equal(admin.length, 1);
    assert.match(admin[0].body.text.body, /Customer needs help/);
    assert.match(admin[0].body.text.body, /my blue shirt is missing/);

    // Logged as handoff so it is never reused as a learned answer
    assert.deepEqual((await outboundLog(phone)).map((m) => m.intent), ['handoff']);
  });

  it('learns: a later similar question sees the earlier answer in its prompt', async () => {
    openai.onIntent(() => json({ intent: 'question' }));
    openai.onReply(({ userText }) =>
      json({ reply: userText.includes('curtains') ? 'Yes, curtains take 3 days.' : 'Other answer', needsHuman: false })
    );

    await server.postWebhook(webhookPayload([textMessage('wamid.ai.learn1', '919400000003', 'Do you wash curtains?')]));
    await waitForDone('wamid.ai.learn1');
    await query(`UPDATE messages SET approved_at = NOW() WHERE client_phone = '919400000003' AND direction = 'outbound'`); // staff approval

    await server.postWebhook(webhookPayload([textMessage('wamid.ai.learn2', '919400000004', 'can you wash my curtains')]));
    await waitForDone('wamid.ai.learn2');

    const replyRequests = openai.ofKind('reply');
    assert.equal(replyRequests.length, 2);
    assert.match(replyRequests[0].system, /\(none yet\)/);
    assert.match(replyRequests[1].system, /Q: Do you wash curtains\?\nA: Yes, curtains take 3 days\./);
  });

  it('continues the conversation with history from the same customer', async () => {
    const phone = '919400000005';
    openai.onIntent(() => json({ intent: 'question' }));
    openai.onReply(() => json({ reply: 'We are open 8 AM to 8 PM.', needsHuman: false }));

    await server.postWebhook(webhookPayload([textMessage('wamid.ai.h1', phone, 'what are your hours?')]));
    await waitForDone('wamid.ai.h1');
    openai.reset();
    openai.onIntent(() => json({ intent: 'question' }));

    await server.postWebhook(webhookPayload([textMessage('wamid.ai.h2', phone, 'and on sunday?')]));
    await waitForDone('wamid.ai.h2');

    const turns = openai.ofKind('reply')[0].body.messages.slice(1);
    assert.deepEqual(turns, [
      { role: 'user', content: 'what are your hours?' },
      { role: 'assistant', content: 'We are open 8 AM to 8 PM.' },
      { role: 'user', content: 'and on sunday?' },
    ]);
  });

  it('uses the AI intent to act on messages keywords would miss', async () => {
    const phone = '919400000006';
    const booking = await createBooking(business.id, { clientPhone: phone, clientName: 'Ravi', serviceType: 'Wash & Iron' });
    openai.onIntent(() => json({ intent: 'cancel' }));

    await server.postWebhook(webhookPayload([textMessage('wamid.ai.cancel', phone, "don't come tomorrow, not needed anymore")]));
    assert.equal((await waitForDone('wamid.ai.cancel')).status, 'done');
    assert.match(graph.sentTo(phone)[0].body.interactive.body.text, /Cancel order #/);

    await server.postWebhook(webhookPayload([tapMessage('wamid.ai.cancel.yes', phone, `cxl_yes_${booking.id}`)]));
    assert.equal((await waitForDone('wamid.ai.cancel.yes')).status, 'done');

    const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [booking.id]);
    assert.equal(rows[0].status, 'Cancelled');
    assert.equal(graph.sentTo(phone)[1].body.template.name, TEST_ENV.TEMPLATE_BOOKING_CANCELLED);
    assert.equal(openai.ofKind('reply').length, 0, 'no AI reply for actions');
  });

  it('degrades gracefully when OpenAI is down: keyword intent, fallback reply, admin hand-off', async () => {
    const phone = '919400000007';
    openai.onIntent(() => httpError(400));
    openai.onReply(() => httpError(400));

    await server.postWebhook(webhookPayload([textMessage('wamid.ai.down', phone, 'what are your prices?')]));
    assert.equal((await waitForDone('wamid.ai.down')).status, 'done');

    const { rows } = await query(
      `SELECT intent FROM messages WHERE client_phone = $1 AND direction = 'inbound'`,
      [phone]
    );
    assert.equal(rows[0].intent, 'question', 'keyword fallback intent');
    assert.match(graph.sentTo(phone)[0].body.text.body, /team will get back to you/);
    assert.equal(adminMessagesAbout(graph, phone).length, 1);
  });
});
