/**
 * src/controllers/adminController.js
 * Admin dashboard: login/logout, bookings list, payment settings, cash collection.
 * The business is always taken from the logged-in admin's session, never from the request.
 */

const {
  findAdminByEmail, createSession, deleteSession, listBusinessesWithSettings,
} = require('../models/adminModel');
const { getPaymentSettings, savePaymentSettings, validateSettings } = require('../models/paymentSettingsModel');
const { listBookingsWithPayments } = require('../models/paymentModel');
const { listAiAnswers, setAnswerApproval } = require('../models/conversationModel');
const paymentService = require('../services/paymentService');
const razorpay = require('../services/razorpayService');
const { verifyPassword } = require('../utils/passwords');
const {
  sessionToken, setSessionCookie, clearSessionCookie, isLoginBlocked, recordLoginFailure, clearLoginFailures,
} = require('../middleware/adminAuth');
const { renderLogin, renderBookings, renderSettings, renderSettingsOverview, renderAiAnswers } = require('../views/adminPages');
const { esc, newNonce, setPageHeaders } = require('../views/html');

// Same work for unknown emails as for wrong passwords (no user enumeration by timing).
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const flash = (kind, text) => `<div class="notice ${kind}">${esc(text)}</div>`;

// A status already set by the caller (e.g. res.status(400) before re-rendering a page) wins over 200.
const render = (res, status, html, nonce) => {
  setPageHeaders(res, nonce);
  return res.status(status === 200 && res.statusCode !== 200 ? res.statusCode : status).send(html);
};

// ---------------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------------
const showLogin = (req, res) => {
  if (req.admin) return res.redirect(303, '/admin/bookings');
  const nonce = newNonce();
  return render(res, 200, renderLogin({ nonce }), nonce);
};

const login = async (req, res, next) => {
  const nonce = newNonce();
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  try {
    if (isLoginBlocked(req, email)) {
      return render(res, 429, renderLogin({ nonce, error: 'Too many attempts. Try again in 15 minutes.' }), nonce);
    }

    const admin = await findAdminByEmail(email);
    const valid = await verifyPassword(password, admin?.password_hash || DUMMY_HASH);
    if (!admin || !valid) {
      recordLoginFailure(req, email);
      return render(res, 401, renderLogin({ nonce, error: 'Wrong email or password.' }), nonce);
    }

    clearLoginFailures(req, email);
    const session = await createSession(admin.id);
    setSessionCookie(req, res, session.token, session.maxAgeSeconds);
    console.log(`[admin] Login ${admin.role} ${admin.id}`);
    return res.redirect(303, '/admin/bookings');
  } catch (err) {
    return next(err);
  }
};

const logout = async (req, res, next) => {
  try {
    await deleteSession(sessionToken(req));
    clearSessionCookie(req, res);
    return res.redirect(303, '/admin/login');
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------
const showBookings = async (req, res, next, message = '') => {
  const nonce = newNonce();
  try {
    const businessId = req.admin.role === 'super_admin' ? null : req.admin.business_id;
    const bookings = await listBookingsWithPayments({ businessId });
    return render(res, 200, renderBookings({ nonce, admin: req.admin, csrf: req.admin.csrf_token, bookings, flash: message }), nonce);
  } catch (err) {
    return next(err);
  }
};

const recordCash = async (req, res, next) => {
  if (!UUID.test(req.params.id)) return showBookings(req, res.status(400), next, flash('bad', 'Invalid booking.'));
  try {
    const { booking } = await paymentService.recordCashPayment({ bookingId: req.params.id, businessId: req.admin.business_id });
    return showBookings(req, res, next, flash('ok', `Cash recorded for booking #${booking.id.slice(0, 8).toUpperCase()}.`));
  } catch (err) {
    if (err.status && err.status < 500) return showBookings(req, res.status(err.status), next, flash('bad', err.message));
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// Payment settings
// ---------------------------------------------------------------------------
const showSettings = async (req, res, next, message = '', formValues = null) => {
  const nonce = newNonce();
  try {
    if (req.admin.role === 'super_admin') {
      const businesses = await listBusinessesWithSettings();
      return render(res, 200, renderSettingsOverview({ nonce, admin: req.admin, csrf: req.admin.csrf_token, businesses }), nonce);
    }
    const settings = formValues || (await getPaymentSettings(req.admin.business_id));
    return render(res, 200, renderSettings({
      nonce, admin: req.admin, csrf: req.admin.csrf_token, settings, razorpayConfigured: razorpay.isConfigured(), flash: message,
    }), nonce);
  } catch (err) {
    return next(err);
  }
};

const saveSettings = async (req, res, next) => {
  const form = req.body || {};
  const input = {
    paymentEnabled: form.paymentEnabled === 'on',
    paymentMode: form.paymentMode,
    advanceType: form.advanceType,
    advanceValue: form.advanceValue === '' ? null : form.advanceValue,
    allowCashOnDelivery: form.allowCashOnDelivery === 'on',
    onlineProvider: form.onlineProvider,
    whatsappPayConfiguration: form.whatsappPayConfiguration,
    whatsappPayGateway: form.whatsappPayGateway,
  };

  try {
    let settings;
    try {
      settings = validateSettings(input);
    } catch (err) {
      if (input.paymentEnabled) throw err;
      // Turning payment off never fails because of an unfinished advance field: keep the saved values.
      const current = await getPaymentSettings(req.admin.business_id);
      settings = { ...current, paymentEnabled: false, allowCashOnDelivery: input.allowCashOnDelivery };
      if (settings.onlineProvider === 'whatsapp_pay' && !settings.whatsappPayConfiguration) settings.onlineProvider = 'razorpay_link';
    }

    if (settings.paymentEnabled && settings.onlineProvider === 'razorpay_link' && !razorpay.isConfigured() && !settings.allowCashOnDelivery) {
      const e = new Error('The Razorpay link needs Razorpay keys on the server. Configure them, choose WhatsApp Pay, or enable Cash on delivery.');
      e.status = 400;
      throw e;
    }

    const saved = await savePaymentSettings(req.admin.business_id, settings, req.admin.id);
    console.log(`[admin] Payment settings saved for business ${req.admin.business_id} by ${req.admin.id}`);
    return showSettings(req, res, next, flash('ok', 'Payment settings saved. They apply to new bookings.'), saved);
  } catch (err) {
    if (err.status === 400) {
      return showSettings(req, res.status(400), next, flash('bad', err.message), { ...input, advanceValue: form.advanceValue });
    }
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// AI answers: staff approve which answers the assistant may reuse for other customers
// ---------------------------------------------------------------------------
const showAiAnswers = async (req, res, next, message = '') => {
  const nonce = newNonce();
  try {
    const answers = await listAiAnswers();
    return render(res, 200, renderAiAnswers({ nonce, admin: req.admin, csrf: req.admin.csrf_token, answers, flash: message }), nonce);
  } catch (err) {
    return next(err);
  }
};

const reviewAiAnswer = (approved) => async (req, res, next) => {
  if (!UUID.test(req.params.id)) return showAiAnswers(req, res.status(400), next, flash('bad', 'Invalid answer.'));
  try {
    const updated = await setAnswerApproval(req.params.id, req.admin.id, approved);
    if (!updated) return showAiAnswers(req, res.status(404), next, flash('bad', 'Answer not found.'));
    console.log(`[admin] AI answer ${updated.id} ${approved ? 'approved' : 'unapproved'} by ${req.admin.id}`);
    return showAiAnswers(req, res, next, flash('ok', approved ? 'Answer approved: the assistant may reuse it.' : 'Approval removed.'));
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  showLogin, login, logout, showBookings, recordCash, showSettings, saveSettings,
  showAiAnswers, approveAiAnswer: reviewAiAnswer(true), unapproveAiAnswer: reviewAiAnswer(false),
};
