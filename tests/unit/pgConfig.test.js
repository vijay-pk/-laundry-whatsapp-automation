/**
 * Unit tests: src/config/pgConfig.js (DATABASE_URL + DATABASE_CA_CERT -> node-postgres config)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { pgConnectionConfig } = require('../../src/config/pgConfig');

const URL_WITH_SSL = 'postgresql://postgres.abc:p%40ss@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require&application_name=laundry';
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

describe('pgConnectionConfig', () => {
  it('passes the URL through unchanged without a CA', () => {
    assert.deepEqual(pgConnectionConfig(URL_WITH_SSL, ''), { connectionString: URL_WITH_SSL });
    assert.deepEqual(pgConnectionConfig(URL_WITH_SSL, undefined), { connectionString: URL_WITH_SSL });
  });

  it('verifies against the CA and drops the URL ssl params (they would override it)', () => {
    const config = pgConnectionConfig(URL_WITH_SSL, PEM);
    assert.deepEqual(config.ssl, { ca: PEM, rejectUnauthorized: true });
    const url = new URL(config.connectionString);
    assert.equal(url.searchParams.get('sslmode'), null);
    assert.equal(url.searchParams.get('application_name'), 'laundry', 'other params kept');
    assert.equal(url.password, 'p%40ss', 'password encoding kept');
    assert.equal(url.host, 'aws-0-ap-southeast-1.pooler.supabase.com:5432');
  });

  it('accepts a one-line PEM with literal \n (env var editors)', () => {
    const config = pgConnectionConfig(URL_WITH_SSL, PEM.replace(/\n/g, '\n'));
    assert.equal(config.ssl.ca, PEM);
  });

  it('ignores the CA for a local database (no TLS there)', () => {
    const local = 'postgresql://postgres:pw@localhost:5433/laundry';
    assert.deepEqual(pgConnectionConfig(local, PEM), { connectionString: local });
  });

  it('explains an invalid URL without leaking the password', () => {
    const bad = 'postgresql://postgres.abc:Secret#123@aws-0-ap-south-1.pooler.supabase.com:5432/postgres';
    assert.throws(() => pgConnectionConfig(bad, PEM), (err) => {
      assert.match(err.message, /URL-encoded/);
      assert.doesNotMatch(err.message + JSON.stringify(err), /Secret/);
      return true;
    });
  });

  it('rejects a value that is not a PEM certificate', () => {
    assert.throws(() => pgConnectionConfig(URL_WITH_SSL, 'not-a-cert'), /PEM certificate/);
  });
});
