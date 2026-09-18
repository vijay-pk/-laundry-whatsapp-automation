/**
 * src/config/pgConfig.js
 * Connection settings for node-postgres from DATABASE_URL (+ optional DATABASE_CA_CERT).
 *
 * node-postgres treats `sslmode=require` as `verify-full`, so a server whose certificate
 * comes from a private CA (Supabase) fails with "self-signed certificate in certificate chain".
 * Set DATABASE_CA_CERT to that CA (PEM; Supabase: Database settings -> SSL -> Download certificate)
 * to verify it properly. The URL's own ssl* parameters are then ignored, because node-postgres
 * lets the connection string override the `ssl` option.
 */

const SSL_PARAMS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

// Render/Railway env editors may store a PEM on one line with literal "\n".
const normalizePem = (value) => String(value).replace(/\\n/g, '\n').trim();

/**
 * @param {string} databaseUrl
 * @param {string} [caCert] PEM text of the server's CA (default: DATABASE_CA_CERT)
 * @returns {{ connectionString: string, ssl?: { ca: string, rejectUnauthorized: true } }}
 */
const pgConnectionConfig = (databaseUrl, caCert = process.env.DATABASE_CA_CERT) => {
  if (!caCert || !String(caCert).trim()) return { connectionString: databaseUrl };

  const ca = normalizePem(caCert);
  if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('[db] DATABASE_CA_CERT must be a PEM certificate (-----BEGIN CERTIFICATE-----)');
  }

  const url = new URL(databaseUrl);
  SSL_PARAMS.forEach((param) => url.searchParams.delete(param));
  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
};

module.exports = { pgConnectionConfig };
