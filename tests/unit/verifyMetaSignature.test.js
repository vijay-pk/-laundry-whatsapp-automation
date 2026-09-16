/**
 * Unit tests: src/utils/verifyMetaSignature.js (no database needed)
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { verifyMetaSignature } = require('../../src/utils/verifyMetaSignature');

const SECRET = 'unit_test_secret';
const RAW = Buffer.from('{"entry":[{"changes":[]}]}');
const sign = (buf, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');

// Minimal Express req/res doubles
const makeReq = (options = {}) => ({
  rawBody: 'rawBody' in options ? options.rawBody : RAW,
  signature: options.signature,
  get(name) {
    return name.toLowerCase() === 'x-hub-signature-256' ? this.signature : undefined;
  },
});

const run = (req) => {
  const result = { status: null, nextCalled: false };
  const res = { sendStatus: (code) => { result.status = code; return res; } };
  verifyMetaSignature(req, res, () => { result.nextCalled = true; });
  return result;
};

describe('verifyMetaSignature', () => {
  let originalSecret;
  beforeEach(() => {
    originalSecret = process.env.META_APP_SECRET;
    process.env.META_APP_SECRET = SECRET;
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = originalSecret;
  });

  it('calls next() for a valid signature', () => {
    const r = run(makeReq({ signature: sign(RAW) }));
    assert.equal(r.nextCalled, true);
    assert.equal(r.status, null);
  });

  it('rejects a missing header with 401', () => {
    const r = run(makeReq({ signature: undefined }));
    assert.equal(r.status, 401);
    assert.equal(r.nextCalled, false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const r = run(makeReq({ signature: sign(RAW).replace('sha256=', 'sha1=') }));
    assert.equal(r.status, 401);
  });

  it('rejects a signature made with another secret', () => {
    const r = run(makeReq({ signature: sign(RAW, 'wrong_secret') }));
    assert.equal(r.status, 401);
  });

  it('rejects a tampered body', () => {
    const r = run(makeReq({ signature: sign(RAW), rawBody: Buffer.from('{"entry":[]}') }));
    assert.equal(r.status, 401);
  });

  it('rejects a malformed / short hex signature without throwing', () => {
    assert.equal(run(makeReq({ signature: 'sha256=zz12' })).status, 401);
    assert.equal(run(makeReq({ signature: 'sha256=' })).status, 401);
  });

  it('rejects when there is no raw body (non-JSON request)', () => {
    const r = run(makeReq({ signature: sign(RAW), rawBody: undefined }));
    assert.equal(r.status, 401);
  });

  it('fails closed with 500 when META_APP_SECRET is not set', () => {
    delete process.env.META_APP_SECRET;
    const r = run(makeReq({ signature: sign(RAW) }));
    assert.equal(r.status, 500);
    assert.equal(r.nextCalled, false);
  });
});
