/**
 * Unit tests: money math, payment settings validation, Razorpay signatures, passwords
 * (no network, no database queries).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { calculatePaymentTerms, bookingTotal, formatINR, toPaise } = require('../../src/utils/money');
const { validateSettings } = require('../../src/models/paymentSettingsModel');
const { hashPassword, verifyPassword } = require('../../src/utils/passwords');

describe('calculatePaymentTerms', () => {
  it('TEST 2 terms: full payment of ₹500 -> pay ₹500, remaining ₹0', () => {
    const t = calculatePaymentTerms(500, { mode: 'full' });
    assert.equal(t.dueNow, 500);
    assert.equal(t.remaining, 0);
  });

  it('TEST 3 terms: 30% advance of ₹500 -> pay ₹150, remaining ₹350', () => {
    const t = calculatePaymentTerms(500, { mode: 'advance', advanceType: 'percentage', advanceValue: 30 });
    assert.deepEqual([t.dueNow, t.remaining], [150, 350]);
  });

  it('TEST 4 terms: fixed ₹100 advance of ₹500 -> pay ₹100, remaining ₹400', () => {
    const t = calculatePaymentTerms(500, { mode: 'advance', advanceType: 'fixed', advanceValue: 100 });
    assert.deepEqual([t.dueNow, t.remaining], [100, 400]);
  });

  it('supports 20% and 50% and rounds to paise', () => {
    assert.equal(calculatePaymentTerms(500, { mode: 'advance', advanceType: 'percentage', advanceValue: 20 }).dueNow, 100);
    assert.equal(calculatePaymentTerms(500, { mode: 'advance', advanceType: 'percentage', advanceValue: 50 }).dueNow, 250);
    const odd = calculatePaymentTerms(333.33, { mode: 'advance', advanceType: 'percentage', advanceValue: 33 });
    assert.equal(toPaise(odd.dueNow) + toPaise(odd.remaining), toPaise(333.33), 'no paise lost');
  });

  it('never asks for more than the total, nor less than ₹1', () => {
    assert.equal(calculatePaymentTerms(80, { mode: 'advance', advanceType: 'fixed', advanceValue: 100 }).dueNow, 80);
    assert.equal(calculatePaymentTerms(50, { mode: 'advance', advanceType: 'percentage', advanceValue: 1 }).dueNow, 1);
  });

  it('rejects invalid totals and advances', () => {
    assert.throws(() => calculatePaymentTerms(0, { mode: 'full' }));
    assert.throws(() => calculatePaymentTerms(500, { mode: 'advance', advanceType: 'percentage', advanceValue: 150 }));
    assert.throws(() => calculatePaymentTerms(500, { mode: 'advance', advanceType: 'fixed', advanceValue: -5 }));
    assert.throws(() => calculatePaymentTerms(500, { mode: 'advance' }));
  });

  it('computes totals and formats rupees', () => {
    assert.equal(bookingTotal(10, 50), 500);
    assert.equal(bookingTotal(2.5, 90), 225);
    assert.equal(formatINR(1250), '₹1,250');
    assert.equal(formatINR(99.5), '₹99.50');
  });
});

describe('validateSettings', () => {
  it('defaults to payment off, full mode', () => {
    assert.deepEqual(validateSettings({}), {
      paymentEnabled: false, paymentMode: 'full', advanceType: null, advanceValue: null, allowCashOnDelivery: false,
      onlineProvider: 'razorpay_link', whatsappPayConfiguration: null, whatsappPayGateway: null,
    });
  });

  it('requires a configuration name and gateway for WhatsApp Pay', () => {
    const ok = validateSettings({ paymentEnabled: true, onlineProvider: 'whatsapp_pay', whatsappPayConfiguration: ' laundry-upi ', whatsappPayGateway: 'razorpay' });
    assert.deepEqual([ok.onlineProvider, ok.whatsappPayConfiguration, ok.whatsappPayGateway], ['whatsapp_pay', 'laundry-upi', 'razorpay']);
    assert.throws(() => validateSettings({ onlineProvider: 'whatsapp_pay', whatsappPayGateway: 'payu' }), { status: 400 });
    assert.throws(() => validateSettings({ onlineProvider: 'whatsapp_pay', whatsappPayConfiguration: 'x'.repeat(61), whatsappPayGateway: 'payu' }), { status: 400 });
    assert.throws(() => validateSettings({ onlineProvider: 'whatsapp_pay', whatsappPayConfiguration: 'cfg', whatsappPayGateway: 'paypal' }), { status: 400 });
    assert.equal(validateSettings({ onlineProvider: 'bitcoin' }).onlineProvider, 'razorpay_link');
  });

  it('accepts percentage and fixed advances', () => {
    assert.equal(validateSettings({ paymentEnabled: true, paymentMode: 'advance', advanceType: 'percentage', advanceValue: '30' }).advanceValue, 30);
    assert.equal(validateSettings({ paymentEnabled: true, paymentMode: 'advance', advanceType: 'fixed', advanceValue: '100' }).advanceType, 'fixed');
  });

  it('rejects invalid advance settings with status 400', () => {
    assert.throws(() => validateSettings({ paymentMode: 'advance', advanceType: 'percentage', advanceValue: '101' }), { status: 400 });
    assert.throws(() => validateSettings({ paymentMode: 'advance', advanceType: 'fixed', advanceValue: '0' }), { status: 400 });
    assert.throws(() => validateSettings({ paymentMode: 'advance', advanceValue: '10' }), { status: 400 });
    assert.throws(() => validateSettings({ paymentMode: 'advance', advanceType: 'percentage', advanceValue: 'abc' }), { status: 400 });
  });
});

describe('Razorpay signatures', () => {
  const env = {};
  let razorpay;
  before(() => {
    for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) env[k] = process.env[k];
    process.env.RAZORPAY_KEY_ID = 'rzp_test_unit';
    process.env.RAZORPAY_KEY_SECRET = 'unit_secret';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'unit_webhook_secret';
    razorpay = require('../../src/services/razorpayService');
  });
  after(() => {
    for (const [k, v] of Object.entries(env)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  });

  const sig = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

  it('verifies a genuine checkout signature', () => {
    assert.equal(razorpay.verifyCheckoutSignature('order_ABC123', 'pay_XYZ789', sig('unit_secret', 'order_ABC123|pay_XYZ789')), true);
  });

  it('rejects tampered, swapped, missing or malformed checkout signatures', () => {
    const good = sig('unit_secret', 'order_ABC123|pay_XYZ789');
    assert.equal(razorpay.verifyCheckoutSignature('order_ABC123', 'pay_OTHER', good), false);
    assert.equal(razorpay.verifyCheckoutSignature('order_ABC123', 'pay_XYZ789', sig('wrong', 'order_ABC123|pay_XYZ789')), false);
    assert.equal(razorpay.verifyCheckoutSignature('order_ABC123', 'pay_XYZ789', ''), false);
    assert.equal(razorpay.verifyCheckoutSignature('order_ABC123', 'pay_XYZ789', 'not-hex'), false);
    assert.equal(razorpay.verifyCheckoutSignature('order_ABC123', 'pay_XYZ789', undefined), false);
  });

  it('verifies webhook signatures over the raw body only', () => {
    const body = Buffer.from('{"event":"payment.captured"}');
    assert.equal(razorpay.verifyWebhookSignature(body, sig('unit_webhook_secret', body)), true);
    assert.equal(razorpay.verifyWebhookSignature(Buffer.from('{"event": "payment.captured"}'), sig('unit_webhook_secret', body)), false);
    assert.equal(razorpay.verifyWebhookSignature(body, sig('unit_secret', body)), false, 'key secret is not the webhook secret');
  });

  it('is unconfigured without keys', () => {
    process.env.RAZORPAY_KEY_SECRET = '';
    assert.equal(razorpay.isConfigured(), false);
    assert.equal(razorpay.verifyCheckoutSignature('order_ABC123', 'pay_XYZ789', sig('', 'order_ABC123|pay_XYZ789')), false);
    process.env.RAZORPAY_KEY_SECRET = 'unit_secret';
  });
});

describe('passwords', () => {
  it('hashes and verifies; rejects wrong and short passwords', async () => {
    const hash = await hashPassword('correct horse battery');
    assert.match(hash, /^scrypt\$/);
    assert.equal(await verifyPassword('correct horse battery', hash), true);
    assert.equal(await verifyPassword('wrong password!!', hash), false);
    assert.equal(await verifyPassword('x', 'garbage'), false);
    await assert.rejects(hashPassword('short'));
  });
});
