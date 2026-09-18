/**
 * src/models/paymentSettingsModel.js
 * Per-business payment settings. No row means payment is disabled (the default).
 */

const { isQrChannel } = require('../config/channel');
const { query } = require('../config/db');

// How customers pay online:
//   razorpay_link  - WhatsApp message with a link to our Razorpay Checkout page (/pay/<token>)
//   whatsapp_pay   - in-chat WhatsApp Pay (order_details message) via a gateway linked in WhatsApp Manager
const ONLINE_PROVIDERS = ['razorpay_link', 'whatsapp_pay'];
const WHATSAPP_PAY_GATEWAYS = ['razorpay', 'payu', 'billdesk', 'zaakpay'];

const DEFAULT_SETTINGS = Object.freeze({
  paymentEnabled: false,
  paymentMode: 'full',
  advanceType: null,
  advanceValue: null,
  allowCashOnDelivery: false,
  onlineProvider: 'razorpay_link',
  whatsappPayConfiguration: null,
  whatsappPayGateway: null,
  currency: 'INR',
  updatedAt: null,
});

const createError = (message, status) => Object.assign(new Error(message), { status });

const fromRow = (row) =>
  row
    ? {
        paymentEnabled: row.payment_enabled,
        paymentMode: row.payment_mode,
        advanceType: row.advance_type,
        advanceValue: row.advance_value === null ? null : Number(row.advance_value),
        allowCashOnDelivery: row.allow_cash_on_delivery,
        onlineProvider: row.online_provider || 'razorpay_link',
        whatsappPayConfiguration: row.whatsapp_pay_configuration,
        whatsappPayGateway: row.whatsapp_pay_gateway,
        currency: row.currency,
        updatedAt: row.updated_at,
      }
    : { ...DEFAULT_SETTINGS };

/**
 * Validate and normalize settings input (from the admin form).
 * @returns {object} normalized settings
 * @throws {Error} status 400 with a readable message
 */
const validateSettings = (input) => {
  const paymentEnabled = input.paymentEnabled === true;
  const paymentMode = input.paymentMode === 'advance' ? 'advance' : 'full';
  const allowCashOnDelivery = input.allowCashOnDelivery === true;
  const onlineProvider = ONLINE_PROVIDERS.includes(input.onlineProvider) ? input.onlineProvider : 'razorpay_link';

  let advanceType = null;
  let advanceValue = null;

  if (paymentMode === 'advance') {
    if (!['percentage', 'fixed'].includes(input.advanceType)) {
      throw createError('Choose an advance type: percentage or fixed amount', 400);
    }
    advanceType = input.advanceType;
    advanceValue = Number(input.advanceValue);

    if (!Number.isFinite(advanceValue) || advanceValue <= 0) {
      throw createError('Advance amount must be a number greater than zero', 400);
    }
    if (advanceType === 'percentage' && advanceValue > 100) {
      throw createError('Advance percentage cannot be more than 100', 400);
    }
    if (advanceType === 'fixed' && advanceValue < 1) {
      throw createError('Fixed advance must be at least ₹1', 400);
    }
    advanceValue = Math.round(advanceValue * 100) / 100;
  }

  let whatsappPayConfiguration = typeof input.whatsappPayConfiguration === 'string' ? input.whatsappPayConfiguration.trim() : '';
  let whatsappPayGateway = WHATSAPP_PAY_GATEWAYS.includes(input.whatsappPayGateway) ? input.whatsappPayGateway : null;

  if (onlineProvider === 'whatsapp_pay' && isQrChannel()) {
    throw createError('WhatsApp Pay needs the official WhatsApp Cloud API. With QR login, use the Razorpay payment link.', 400);
  }
  if (onlineProvider === 'whatsapp_pay') {
    // Name exactly as created in WhatsApp Manager > Payment configurations (Meta limit 60 chars).
    if (!/^[A-Za-z0-9 _.\-]{1,60}$/.test(whatsappPayConfiguration)) {
      throw createError('Enter the WhatsApp Pay payment configuration name exactly as in WhatsApp Manager (max 60 characters)', 400);
    }
    if (!whatsappPayGateway) {
      throw createError('Choose the payment gateway linked to that WhatsApp Pay configuration', 400);
    }
  } else if (!whatsappPayConfiguration) {
    whatsappPayConfiguration = null;
    whatsappPayGateway = whatsappPayGateway || null;
  }

  return {
    paymentEnabled,
    paymentMode,
    advanceType,
    advanceValue,
    allowCashOnDelivery,
    onlineProvider,
    whatsappPayConfiguration: whatsappPayConfiguration || null,
    whatsappPayGateway,
  };
};

const getPaymentSettings = async (businessId) => {
  const { rows } = await query('SELECT * FROM business_payment_settings WHERE business_id = $1', [businessId]);
  return fromRow(rows[0]);
};

/**
 * Create or update one business's settings. businessId must come from the authenticated
 * admin's session, never from user input.
 */
const savePaymentSettings = async (businessId, input, adminId = null) => {
  const s = validateSettings(input);
  const { rows } = await query(
    `INSERT INTO business_payment_settings
       (business_id, payment_enabled, payment_mode, advance_type, advance_value, allow_cash_on_delivery,
        online_provider, whatsapp_pay_configuration, whatsapp_pay_gateway, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (business_id) DO UPDATE SET
       payment_enabled = EXCLUDED.payment_enabled,
       payment_mode = EXCLUDED.payment_mode,
       advance_type = EXCLUDED.advance_type,
       advance_value = EXCLUDED.advance_value,
       allow_cash_on_delivery = EXCLUDED.allow_cash_on_delivery,
       online_provider = EXCLUDED.online_provider,
       whatsapp_pay_configuration = EXCLUDED.whatsapp_pay_configuration,
       whatsapp_pay_gateway = EXCLUDED.whatsapp_pay_gateway,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [
      businessId, s.paymentEnabled, s.paymentMode, s.advanceType, s.advanceValue, s.allowCashOnDelivery,
      s.onlineProvider, s.whatsappPayConfiguration, s.whatsappPayGateway, adminId,
    ]
  );
  return fromRow(rows[0]);
};

module.exports = {
  ONLINE_PROVIDERS,
  WHATSAPP_PAY_GATEWAYS,
  DEFAULT_SETTINGS,
  validateSettings,
  getPaymentSettings,
  savePaymentSettings,
};
