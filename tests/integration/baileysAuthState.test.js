/**
 * Integration tests: src/channels/baileysAuthState.js + whatsappAuthModel (QR-login session in Postgres)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, resetDb, closeDb } = require('../helpers/db');
const { usePostgresAuthState } = require('../../src/channels/baileysAuthState');

describe('usePostgresAuthState', () => {
  let baileys;

  before(async () => {
    await resetDb();
    baileys = await import('@whiskeysockets/baileys');
  });

  after(closeDb);

  it('starts with fresh credentials and keeps them across restarts', async () => {
    const first = await usePostgresAuthState(baileys);
    assert.ok(Buffer.isBuffer(first.state.creds.noiseKey.private), 'fresh creds from initAuthCreds');
    first.state.creds.me = { id: '919876543210:1@s.whatsapp.net' };
    await first.saveCreds();

    const second = await usePostgresAuthState(baileys);
    assert.equal(second.state.creds.me.id, '919876543210:1@s.whatsapp.net');
    assert.deepEqual(second.state.creds.noiseKey.private, first.state.creds.noiseKey.private, 'Buffers survive JSON');
  });

  it('stores, reads and deletes Signal keys', async () => {
    const { state } = await usePostgresAuthState(baileys);
    await state.keys.set({ 'pre-key': { 1: { public: Buffer.from([1, 2]), private: Buffer.from([3]) }, 2: { public: Buffer.from([4]), private: Buffer.from([5]) } } });

    const got = await state.keys.get('pre-key', ['1', '2', '3']);
    assert.deepEqual(got['1'].public, Buffer.from([1, 2]));
    assert.equal(got['3'], null, 'missing key is null');

    await state.keys.set({ 'pre-key': { 1: null } });
    assert.equal((await state.keys.get('pre-key', ['1']))['1'], null, 'null deletes');
    assert.ok((await state.keys.get('pre-key', ['2']))['2']);
  });

  it('decodes app-state sync keys into protobuf objects', async () => {
    const { state } = await usePostgresAuthState(baileys);
    await state.keys.set({ 'app-state-sync-key': { AAA: { keyData: Buffer.from([9, 9]) } } });
    const { AAA } = await state.keys.get('app-state-sync-key', ['AAA']);
    assert.ok(AAA instanceof baileys.proto.Message.AppStateSyncKeyData);
    assert.deepEqual(Buffer.from(AAA.keyData), Buffer.from([9, 9]));
  });

  it('clear() forgets the linked device', async () => {
    const auth = await usePostgresAuthState(baileys);
    await auth.clear();
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM whatsapp_auth')).rows[0].n, 0);
    const fresh = await usePostgresAuthState(baileys);
    assert.equal(fresh.state.creds.me, undefined);
  });
});
