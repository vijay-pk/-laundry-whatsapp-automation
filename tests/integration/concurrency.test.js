/**
 * Integration tests: per-customer locking (withLock) so simultaneous messages from one
 * customer are processed one after another.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, resetDb, createBusiness, closeDb } = require('../helpers/db');
const { startMockGraph } = require('../helpers/mockGraph');
const { startServer, webhookPayload, textMessage, tapMessage, waitFor, sleep } = require('../helpers/server');
const { withLock } = require('../../src/config/db');

describe('Concurrency', () => {
  describe('withLock', () => {
    before(resetDb);

    it('runs one function per key at a time, different keys in parallel', async () => {
      const events = [];
      const job = (key, name, ms) =>
        withLock(key, async () => {
          events.push(`${name}:start`);
          await sleep(ms);
          events.push(`${name}:end`);
        });

      await Promise.all([job('lock-test-a', 'a1', 150), job('lock-test-a', 'a2', 10), job('lock-test-b', 'b1', 10)]);

      const index = (e) => events.indexOf(e);
      const [first, second] = index('a1:start') < index('a2:start') ? ['a1', 'a2'] : ['a2', 'a1'];
      assert.ok(index(`${first}:end`) < index(`${second}:start`), `same key overlapped: ${events.join(', ')}`);
      assert.ok(index('b1:end') < index('a1:end'), `other key waited: ${events.join(', ')}`);
    });

    it('releases the lock when the function throws', async () => {
      await assert.rejects(withLock('lock-test-c', async () => { throw new Error('boom'); }), /boom/);
      assert.equal(await withLock('lock-test-c', async () => 'free'), 'free');
    });
  });

  describe('webhook', () => {
    let graph;
    let server;

    before(async () => {
      const business = await createBusiness();
      graph = await startMockGraph();
      server = await startServer({ graphUrl: graph.url, env: { DEFAULT_BUSINESS_ID: business.id } });
    });

    after(async () => {
      await server?.stop();
      await graph?.close();
      await closeDb();
    });

    const processed = (ids) =>
      waitFor(async () => {
        const { rows } = await query(`SELECT status FROM webhook_events WHERE wa_message_id = ANY($1) AND status = 'done'`, [ids]);
        return rows.length === ids.length;
      });

    it('handles simultaneous messages from one customer in turn (no lost session updates)', async () => {
      const phone = '919900000001';
      await server.postWebhook(webhookPayload([textMessage('wamid.race.book', phone, 'book')]));
      assert.ok(await processed(['wamid.race.book']));

      // Three wrong answers at once: each must see the previous retry count, so the flow gives up.
      const ids = ['wamid.race.1', 'wamid.race.2', 'wamid.race.3'];
      await Promise.all(ids.map((id) => server.postWebhook(webhookPayload([textMessage(id, phone, 'banana')]))));
      assert.ok(await processed(ids), 'all processed');

      const replies = graph.sentTo(phone).slice(1).map((r) => r.body);
      assert.equal(replies.length, 3);
      assert.equal(replies.filter((r) => /Let's start again/.test(r.text?.body || '')).length, 1);
      const { rows } = await query('SELECT * FROM conversation_sessions WHERE client_phone = $1', [phone]);
      assert.equal(rows.length, 0, 'session cleared after the third wrong answer');
    });

    it('two different Confirm taps at once create one booking', async () => {
      const phone = '919900000002';
      const steps = [['text', 'book'], ['tap', 'svc_ironing'], ['text', '1'], ['text', '9 Lavelle Road, Bengaluru'], ['text', 'Meera'], ['tap', 'notes_skip']];
      for (const [i, [kind, value]] of steps.entries()) {
        const id = `wamid.race2.step${i}`;
        const message = kind === 'text' ? textMessage(id, phone, value) : tapMessage(id, phone, value);
        await server.postWebhook(webhookPayload([message]));
        assert.ok(await processed([id]), `step ${i} processed`);
      }

      const ids = ['wamid.race2.c1', 'wamid.race2.c2', 'wamid.race2.c3'];
      await Promise.all(ids.map((id) => server.postWebhook(webhookPayload([tapMessage(id, phone, 'confirm_yes')]))));
      assert.ok(await processed(ids), 'all processed');

      const { rows } = await query('SELECT id FROM bookings WHERE client_phone = $1', [phone]);
      assert.equal(rows.length, 1);
    });
  });
});
