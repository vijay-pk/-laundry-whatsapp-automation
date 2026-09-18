/**
 * scripts/createAdmin.js
 * Create a dashboard login (`npm run admin:create -- --email you@example.com`).
 *
 * Options:
 *   --email <email>        required
 *   --business <uuid>      business the admin manages (default: DEFAULT_BUSINESS_ID from .env)
 *   --role admin|super_admin   (default admin; super_admin sees every business, read-only settings)
 * Password: ADMIN_PASSWORD environment variable, or typed at the prompt (hidden), min 10 characters.
 */

require('dotenv').config({ quiet: true });
const readline = require('readline');

const { createAdmin } = require('../src/models/adminModel');
const { pool } = require('../src/config/db');
const { MIN_PASSWORD_LENGTH } = require('../src/utils/passwords');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

// Read a line without echoing it to the terminal.
const promptHidden = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl._writeToOutput = (s) => rl.output.write(rl.stdoutMuted ? (s.includes(question) ? question : '') : s);
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });

const main = async () => {
  const email = arg('email');
  const role = arg('role') || 'admin';
  const businessId = role === 'super_admin' ? null : arg('business') || process.env.DEFAULT_BUSINESS_ID;

  if (!email) throw new Error('Usage: npm run admin:create -- --email you@example.com [--business <uuid>] [--role admin|super_admin]');

  const password = process.env.ADMIN_PASSWORD || (await promptHidden(`Password (min ${MIN_PASSWORD_LENGTH} characters): `));
  const admin = await createAdmin({ email, password, role, businessId });
  console.log(`✔ Created ${admin.role} ${admin.email}${admin.business_id ? ` for business ${admin.business_id}` : ''}`);
  console.log('Log in at <your server>/admin/login');
};

main()
  .catch((err) => {
    console.error(`✖ ${err.code === '23505' ? 'An admin with this email already exists' : err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
