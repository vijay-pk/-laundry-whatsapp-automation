/**
 * src/routes/payRoutes.js
 * Customer payment page (/pay) and the Razorpay webhook.
 */

const express = require('express');
const pay = require('../controllers/payController');

const payRouter = express.Router();
payRouter.get('/:token', pay.showPaymentPage);
payRouter.post('/:token/order', pay.createOrder);
payRouter.post('/:token/verify', pay.verifyPayment);
payRouter.post('/:token/sync', pay.syncPayment);

const webhookRouter = express.Router();
webhookRouter.post('/razorpay', pay.razorpayWebhook);

module.exports = { payRouter, webhookRouter };
