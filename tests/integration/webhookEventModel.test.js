/**
 * Integration tests: src/models/webhookEventModel.js (webhook idempotency storage)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, resetDb, closeDb } = require('../helpers/db');
const events = require('../../src/models/webhookEventModel');

const eventRow = async (id) =>
  (await query('SELECT * FROM webhook_events WHERE wa_message_id = $1', [id])).rows[0];

describe('webhookEventModel', () => {
  before(resetDb);
  after(closeDb);

  it('claims a new event once', async () => {
    assert.equal(await events.claimEvent('wamid.new'), true);
    assert.equal(await events.claimEvent('wamid.new'), false, 'second claim while processing');
    const row = await eventRow('wamid.new');
    assert.equal(row.status, 'processing');
    assert.equal(row.attempts, 1);
  });

  it('never reclaims a done event', async () => {
    await events.claimEvent('wamid.done');
    await events.markEventDone('wamid.done');
    assert.equal(await events.claimEvent('wamid.done'), false);
    assert.equal((await eventRow('wamid.done')).status, 'done');
  });

  it('retries failed events up to 3 attempts', async () => {
    const id = 'wamid.fail';
    assert.equal(await events.claimEvent(id), true);
    await events.markEventFailed(id, 'boom');
    assert.equal(await events.claimEvent(id), true, 'attempt 2');
    await events.markEventFailed(id, 'boom');
    assert.equal(await events.claimEvent(id), true, 'attempt 3');
    await events.markEventFailed(id, 'boom');
    assert.equal(await events.claimEvent(id), false, 'no attempt 4');

    const row = await eventRow(id);
    assert.equal(row.attempts, 3);
    assert.equal(row.status, 'failed');
  });

  it('clears last_error on done and truncates long errors', async () => {
    const id = 'wamid.err';
    await events.claimEvent(id);
    await events.markEventFailed(id, 'x'.repeat(2000));
    assert.equal((await eventRow(id)).last_error.length, 500);

    await events.claimEvent(id);
    await events.markEventDone(id);
    assert.equal((await eventRow(id)).last_error, null);
  });

  it('reclaims events stuck in processing for more than 10 minutes', async () => {
    const id = 'wamid.stale';
    await events.claimEvent(id);
    await query(`UPDATE webhook_events SET updated_at = NOW() - INTERVAL '9 minutes' WHERE wa_message_id = $1`, [id]);
    assert.equal(await events.claimEvent(id), false, 'not stale yet');

    await query(`UPDATE webhook_events SET updated_at = NOW() - INTERVAL '11 minutes' WHERE wa_message_id = $1`, [id]);
    assert.equal(await events.claimEvent(id), true, 'stale -> reclaimed');
  });

  it('lets exactly one of many concurrent claims win', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => events.claimEvent('wamid.race')));
    assert.equal(results.filter(Boolean).length, 1);
  });

  it('purges events older than the retention period', async () => {
    await events.claimEvent('wamid.old');
    await events.claimEvent('wamid.recent');
    await query(`UPDATE webhook_events SET created_at = NOW() - INTERVAL '31 days' WHERE wa_message_id = 'wamid.old'`);

    const removed = await events.purgeOldEvents();
    assert.equal(removed, 1);
    assert.equal(await eventRow('wamid.old'), undefined);
    assert.ok(await eventRow('wamid.recent'));
  });
});
