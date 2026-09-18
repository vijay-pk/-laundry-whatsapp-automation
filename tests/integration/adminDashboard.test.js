/**
 * End-to-end tests: admin dashboard (login, sessions, CSRF, per-business isolation,
 * payment settings, bookings page, cash collection).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, resetDb, createBusiness, closeDb } = require('../helpers/db');
const { startMockGraph } = require('../helpers/mockGraph');
const { startMockRazorpay } = require('../helpers/mockRazorpay');
const { startServer } = require('../helpers/server');
const { createAdmin } = require('../../src/models/adminModel');
const { getPaymentSettings, savePaymentSettings } = require('../../src/models/paymentSettingsModel');
const { createBooking, logMessage } = require('../../src/models/bookingModel');

const PASSWORD = 'correct-horse-battery';

describe('Admin dashboard', () => {
  let graph;
  let rzp;
  let server;
  let bizA;
  let bizB;

  const login = async (email, password = PASSWORD) => {
    const res = await server.request('POST', '/admin/login', { form: { email, password } });
    const cookie = res.headers.get('set-cookie');
    return { res, cookie: cookie ? cookie.split(';')[0] : null, rawCookie: cookie };
  };

  const get = (path, cookie) => server.request('GET', path, { headers: cookie ? { Cookie: cookie } : {} });
  const post = (path, cookie, form) => server.request('POST', path, { form, headers: { Cookie: cookie } });
  const csrfFrom = (html) => html.match(/name="_csrf" value="([a-f0-9]{64})"/)?.[1];

  const session = async (email) => {
    const { cookie } = await login(email);
    const page = await get('/admin/payment-settings', cookie);
    return { cookie, csrf: csrfFrom(page.text) };
  };

  before(async () => {
    await resetDb();
    bizA = await createBusiness('Laundry A');
    bizB = await createBusiness('Laundry B');
    await createAdmin({ email: 'a@laundry.test', password: PASSWORD, businessId: bizA.id });
    await createAdmin({ email: 'b@laundry.test', password: PASSWORD, businessId: bizB.id });
    await createAdmin({ email: 'root@laundry.test', password: PASSWORD, role: 'super_admin' });

    graph = await startMockGraph();
    rzp = await startMockRazorpay();
    server = await startServer({ graphUrl: graph.url, env: { RAZORPAY_API_BASE_URL: rzp.url, PUBLIC_BASE_URL: 'https://pay.example.test', ...rzp.env } });
  });

  after(async () => {
    await server?.stop();
    await rzp?.close();
    await graph?.close();
    await closeDb();
  });

  describe('authentication', () => {
    it('redirects anonymous visitors to the login page', async () => {
      for (const path of ['/admin', '/admin/bookings', '/admin/payment-settings']) {
        const res = await get(path);
        assert.equal(res.status, 303, path);
        assert.equal(res.headers.get('location'), '/admin/login');
      }
      const denied = await server.request('POST', '/admin/payment-settings', { form: { paymentEnabled: 'on' } });
      assert.equal(denied.status, 303);
    });

    it('rejects wrong passwords and unknown emails with the same message', async () => {
      const wrong = await login('a@laundry.test', 'not-the-password');
      const unknown = await login('nobody@laundry.test', 'not-the-password');
      assert.equal(wrong.res.status, 401);
      assert.equal(unknown.res.status, 401);
      assert.match(wrong.res.text, /Wrong email or password/);
      assert.equal(wrong.cookie, null);
    });

    it('sets an HttpOnly, SameSite=Strict session cookie scoped to /admin', async () => {
      const { res, rawCookie } = await login('a@laundry.test');
      assert.equal(res.status, 303);
      assert.match(rawCookie, /admin_session=[a-f0-9]{64}/);
      assert.match(rawCookie, /HttpOnly/);
      assert.match(rawCookie, /SameSite=Strict/);
      assert.match(rawCookie, /Path=\/admin/);
      const { rows } = await query('SELECT token_hash FROM admin_sessions');
      assert.ok(rows.every((r) => !rawCookie.includes(r.token_hash)), 'only the hash is stored');
    });

    it('throttles repeated failed logins', async () => {
      for (let i = 0; i < 5; i += 1) await login('throttle@laundry.test', 'wrong-password-x');
      const blocked = await login('throttle@laundry.test', 'wrong-password-x');
      assert.equal(blocked.res.status, 429);
    });

    it('blocks an IP that tries many different accounts (password spraying)', async () => {
      const limited = await startServer({ graphUrl: graph.url, env: { ADMIN_LOGIN_MAX_IP_FAILURES: '3' } });
      try {
        const attempt = (email, password = 'wrong-password-x') =>
          limited.request('POST', '/admin/login', { form: { email, password } });
        for (const n of [1, 2, 3]) assert.equal((await attempt(`spray${n}@laundry.test`)).status, 401);
        assert.equal((await attempt('spray4@laundry.test')).status, 429, 'new email, same IP');
        assert.equal((await attempt('a@laundry.test', PASSWORD)).status, 429, 'even a valid login waits');
      } finally {
        await limited.stop();
      }
    });

    it('logs out and invalidates the session', async () => {
      const { cookie, csrf } = await session('a@laundry.test');
      const out = await post('/admin/logout', cookie, { _csrf: csrf });
      assert.equal(out.status, 303);
      assert.equal((await get('/admin/bookings', cookie)).status, 303);
    });
  });

  describe('AI answers', () => {
    let answer;

    before(async () => {
      await logMessage(null, 'inbound', 'Do you clean leather jackets?', 'question', '919600000070');
      answer = await logMessage(null, 'outbound', 'Yes, leather jackets take 5 days.', 'question', '919600000070');
    });

    it('lists AI answers and lets a business admin approve them (with CSRF)', async () => {
      const { cookie, csrf } = await session('a@laundry.test');
      const page = await get('/admin/ai-answers', cookie);
      assert.equal(page.status, 200);
      assert.match(page.text, /Do you clean leather jackets\?/);
      assert.match(page.text, /Not approved/);
      assert.doesNotMatch(page.text, /919600000070/, 'phone masked');

      assert.equal((await post(`/admin/ai-answers/${answer.id}/approve`, cookie, { _csrf: 'x'.repeat(64) })).status, 403);
      const ok = await post(`/admin/ai-answers/${answer.id}/approve`, cookie, { _csrf: csrf });
      assert.equal(ok.status, 200);
      assert.match(ok.text, /Answer approved/);
      assert.ok((await query('SELECT approved_at FROM messages WHERE id = $1', [answer.id])).rows[0].approved_at);

      await post(`/admin/ai-answers/${answer.id}/unapprove`, cookie, { _csrf: csrf });
      assert.equal((await query('SELECT approved_at FROM messages WHERE id = $1', [answer.id])).rows[0].approved_at, null);
    });

    it('is read-only for super admins', async () => {
      const { cookie, csrf } = await session('root@laundry.test');
      const page = await get('/admin/ai-answers', cookie);
      assert.equal(page.status, 200);
      assert.doesNotMatch(page.text, /\/approve"/);
      assert.equal((await post(`/admin/ai-answers/${answer.id}/approve`, cookie, { _csrf: csrf })).status, 403);
    });
  });

  describe('payment settings', () => {
    it('shows OFF by default with the "no payment" preview', async () => {
      const { cookie } = await session('a@laundry.test');
      const page = await get('/admin/payment-settings', cookie);
      assert.equal(page.status, 200);
      assert.match(page.text, /Payment enabled<\/span><b id="pv-enabled">OFF/);
      assert.match(page.text, /No payment will be collected during booking/);
      assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-/);
    });

    it('saves 30% advance with a correct preview', async () => {
      const { cookie, csrf } = await session('a@laundry.test');
      const res = await post('/admin/payment-settings', cookie, {
        _csrf: csrf, paymentEnabled: 'on', paymentMode: 'advance', advanceType: 'percentage', advanceValue: '30',
      });
      assert.equal(res.status, 200);
      assert.match(res.text, /Payment settings saved/);
      assert.match(res.text, /₹500 booking → Customer pays ₹150 now → ₹350 remaining/);

      const saved = await getPaymentSettings(bizA.id);
      assert.deepEqual([saved.paymentEnabled, saved.paymentMode, saved.advanceType, saved.advanceValue], [true, 'advance', 'percentage', 30]);
    });

    it('TEST 8: admin A changing settings does not affect admin B', async () => {
      await savePaymentSettings(bizB.id, { paymentEnabled: true, paymentMode: 'full' });
      const { cookie, csrf } = await session('a@laundry.test');
      await post('/admin/payment-settings', cookie, {
        _csrf: csrf, paymentEnabled: 'on', paymentMode: 'advance', advanceType: 'fixed', advanceValue: '100',
      });

      const b = await getPaymentSettings(bizB.id);
      assert.deepEqual([b.paymentEnabled, b.paymentMode, b.advanceType], [true, 'full', null]);

      // A form field can't target another business: the business comes from the session.
      await post('/admin/payment-settings', cookie, { _csrf: csrf, business_id: bizB.id, businessId: bizB.id });
      assert.equal((await getPaymentSettings(bizB.id)).paymentEnabled, true, 'B untouched');
      assert.equal((await getPaymentSettings(bizA.id)).paymentEnabled, false, 'A turned off');

      const bPage = await get('/admin/payment-settings', (await session('b@laundry.test')).cookie);
      assert.match(bPage.text, /name="paymentMode" value="full" checked/);
    });

    it('keeps the advance configuration when payment is turned off', async () => {
      const { cookie, csrf } = await session('a@laundry.test');
      await post('/admin/payment-settings', cookie, { _csrf: csrf, paymentEnabled: 'on', paymentMode: 'advance', advanceType: 'percentage', advanceValue: '20' });
      await post('/admin/payment-settings', cookie, { _csrf: csrf, paymentMode: 'advance', advanceType: 'percentage', advanceValue: '' });
      const s = await getPaymentSettings(bizA.id);
      assert.deepEqual([s.paymentEnabled, s.advanceValue], [false, 20]);
    });

    it('validates input and requires a CSRF token', async () => {
      const { cookie, csrf } = await session('a@laundry.test');
      const bad = await post('/admin/payment-settings', cookie, { _csrf: csrf, paymentEnabled: 'on', paymentMode: 'advance', advanceType: 'percentage', advanceValue: '150' });
      assert.equal(bad.status, 400);
      assert.match(bad.text, /cannot be more than 100/);

      const noCsrf = await post('/admin/payment-settings', cookie, { paymentEnabled: 'on', paymentMode: 'full' });
      assert.equal(noCsrf.status, 403);
      const wrongCsrf = await post('/admin/payment-settings', cookie, { _csrf: 'f'.repeat(64), paymentEnabled: 'on' });
      assert.equal(wrongCsrf.status, 403);
    });

    it('super admin sees every business read-only and cannot change settings', async () => {
      const { cookie, csrf } = await session('root@laundry.test');
      const page = await get('/admin/payment-settings', cookie);
      assert.match(page.text, /all businesses/);
      assert.match(page.text, /Laundry A/);
      assert.match(page.text, /Laundry B/);
      assert.doesNotMatch(page.text, /name="paymentEnabled"/);
      assert.equal((await post('/admin/payment-settings', cookie, { _csrf: csrf, paymentEnabled: 'on' })).status, 403);
    });
  });

  describe('bookings page', () => {
    let bookingA;
    let bookingB;

    before(async () => {
      bookingA = await createBooking(bizA.id, {
        clientPhone: '919900000001', clientName: 'Asha', serviceType: 'Wash & Fold', status: 'Confirmed',
        totalAmount: 500, paymentStatus: 'pending', paymentMethod: 'cod', paymentMode: 'full', amountDueNow: 0, amountRemaining: 500,
      });
      bookingB = await createBooking(bizB.id, {
        clientPhone: '919900000002', clientName: 'Bala', serviceType: 'Dry Cleaning', status: 'Pending',
        totalAmount: 300, paymentStatus: 'pending', paymentMethod: 'cod', amountDueNow: 0, amountRemaining: 300,
      });
    });

    it('shows only the admin\'s own bookings with booking status and payment status separated', async () => {
      const { cookie } = await session('a@laundry.test');
      const page = await get('/admin/bookings', cookie);
      assert.equal(page.status, 200);
      assert.match(page.text, /Asha/);
      assert.doesNotMatch(page.text, /Bala/, 'no other business data');
      assert.match(page.text, /<th>Booking status<\/th><th>Payment status<\/th>/);
      assert.match(page.text, /Cash on delivery/);
      assert.doesNotMatch(page.text, /Mark paid|mark as paid/i, 'no way to mark online payments paid');
    });

    it('super admin sees all businesses', async () => {
      const page = await get('/admin/bookings', (await session('root@laundry.test')).cookie);
      assert.match(page.text, /Asha/);
      assert.match(page.text, /Bala/);
    });

    it('records cash for own booking only', async () => {
      const a = await session('a@laundry.test');
      const other = await post(`/admin/bookings/${bookingB.id}/cash`, a.cookie, { _csrf: a.csrf });
      assert.equal(other.status, 404, "cannot touch another business's booking");
      assert.equal((await query('SELECT payment_status FROM bookings WHERE id = $1', [bookingB.id])).rows[0].payment_status, 'pending');

      const res = await post(`/admin/bookings/${bookingA.id}/cash`, a.cookie, { _csrf: a.csrf });
      assert.equal(res.status, 200);
      assert.match(res.text, /Cash recorded/);
      const { rows } = await query('SELECT payment_status, amount_paid, amount_remaining FROM bookings WHERE id = $1', [bookingA.id]);
      assert.deepEqual([rows[0].payment_status, Number(rows[0].amount_paid), Number(rows[0].amount_remaining)], ['paid', 500, 0]);
      const payments = (await query('SELECT provider, status FROM payments WHERE booking_id = $1', [bookingA.id])).rows;
      assert.deepEqual(payments, [{ provider: 'cash', status: 'paid' }]);

      const again = await post(`/admin/bookings/${bookingA.id}/cash`, a.cookie, { _csrf: a.csrf });
      assert.equal(again.status, 409, 'cannot record twice');
    });

    it('never records cash for a pending online (Razorpay) payment', async () => {
      const online = await createBooking(bizA.id, {
        clientPhone: '919900000003', serviceType: 'Wash & Fold', totalAmount: 500, paymentStatus: 'pending',
        paymentMethod: 'razorpay', paymentMode: 'full', amountDueNow: 500, amountRemaining: 500, paymentToken: 'c'.repeat(64),
      });
      const a = await session('a@laundry.test');
      const res = await post(`/admin/bookings/${online.id}/cash`, a.cookie, { _csrf: a.csrf });
      assert.equal(res.status, 409);
      assert.match(res.text, /only be confirmed by Razorpay/);
    });
  });
});
