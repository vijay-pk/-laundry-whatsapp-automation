/**
 * src/routes/adminRoutes.js
 * Admin dashboard routes (mounted at /admin).
 */

const express = require('express');
const admin = require('../controllers/adminController');
const { loadAdmin, requireAdmin, requireBusinessAdmin, verifyCsrf } = require('../middleware/adminAuth');

const router = express.Router();

router.use(loadAdmin);

router.get('/login', admin.showLogin);
router.post('/login', admin.login);
router.post('/logout', requireAdmin, verifyCsrf, admin.logout);

router.get('/', requireAdmin, (req, res) => res.redirect(303, '/admin/bookings'));
router.get('/bookings', requireAdmin, (req, res, next) => admin.showBookings(req, res, next));
router.post('/bookings/:id/cash', requireAdmin, requireBusinessAdmin, verifyCsrf, admin.recordCash);

router.get('/payment-settings', requireAdmin, (req, res, next) => admin.showSettings(req, res, next));
router.post('/payment-settings', requireAdmin, requireBusinessAdmin, verifyCsrf, admin.saveSettings);

router.get('/ai-answers', requireAdmin, (req, res, next) => admin.showAiAnswers(req, res, next));
router.post('/ai-answers/:id/approve', requireAdmin, requireBusinessAdmin, verifyCsrf, admin.approveAiAnswer);
router.post('/ai-answers/:id/unapprove', requireAdmin, requireBusinessAdmin, verifyCsrf, admin.unapproveAiAnswer);

module.exports = router;
