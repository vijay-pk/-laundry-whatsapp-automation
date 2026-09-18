-- =============================================================================
-- schema.sql
-- Multi-tenant WhatsApp automation schema (PostgreSQL 13+)
-- Apply: psql $env:DATABASE_URL -f src/models/schema.sql
-- =============================================================================

BEGIN;

-- gen_random_uuid() is built into PG 13+. This extension covers older versions.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- businesses: one row per tenant
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS businesses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(255) NOT NULL,
  whatsapp_number  VARCHAR(20)  NOT NULL UNIQUE,   -- digits with country code
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- bookings: customer orders, scoped to a business
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID         NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_phone     VARCHAR(20)  NOT NULL,          -- digits only, same as webhook `from`
  client_name      VARCHAR(255),
  service_type     VARCHAR(100),
  -- Free-form so other business types can define their own statuses.
  status           VARCHAR(50)  NOT NULL DEFAULT 'Pending',
  pickup_address   TEXT,
  scheduled_time   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Serves "latest booking for this client within this business"
CREATE INDEX IF NOT EXISTS idx_bookings_business_client_created
  ON bookings (business_id, client_phone, created_at DESC);

-- Idempotency for POST /api/bookings: the caller's own booking id (or Idempotency-Key).
-- Unique per business; NULLs don't conflict, so bookings without one are unaffected.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_business_external_id
  ON bookings (business_id, external_id);

-- Chat booking details: special instructions and where the booking came from.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'api';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Geofencing: customer's shared pickup location and its distance from the business.
-- booking_state tracks the booking conversation outcome:
--   'pending' (default, e.g. API bookings), 'awaiting_location', 'confirmed',
--   'rejected' (outside the service radius).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS latitude DECIMAL(9, 6);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS longitude DECIMAL(9, 6);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS distance_km DECIMAL(7, 2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_state VARCHAR(30) NOT NULL DEFAULT 'pending';

-- Serves client lookups that aren't scoped to a business
CREATE INDEX IF NOT EXISTS idx_bookings_client_created
  ON bookings (client_phone, created_at DESC);

-- -----------------------------------------------------------------------------
-- messages: conversation log
-- booking_id is nullable: a message can arrive before any booking exists.
-- client_phone links messages to a customer even without a booking, which
-- the AI needs for conversation history and learning from past answers.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID         REFERENCES bookings(id) ON DELETE SET NULL,
  business_id      UUID         REFERENCES businesses(id) ON DELETE CASCADE,
  client_phone     VARCHAR(20),
  direction        VARCHAR(10)  NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  content          TEXT         NOT NULL,
  intent           VARCHAR(100),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Upgrade path for databases created with the earlier schema
ALTER TABLE messages ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_phone VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_messages_booking_created
  ON messages (booking_id, created_at);

-- Serves conversation history per client
CREATE INDEX IF NOT EXISTS idx_messages_client_created
  ON messages (client_phone, created_at);

-- Serves full-text search over past questions (AI self-learning)
CREATE INDEX IF NOT EXISTS idx_messages_content_fts
  ON messages USING GIN (to_tsvector('english', content));

-- -----------------------------------------------------------------------------
-- webhook_events: idempotency for Meta webhook deliveries
-- One row per WhatsApp message id (wamid). A duplicate delivery conflicts on the
-- primary key and is skipped. Rows older than 30 days are purged by the server.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  wa_message_id    VARCHAR(255) PRIMARY KEY,
  status           VARCHAR(20)  NOT NULL DEFAULT 'processing'
                     CHECK (status IN ('processing', 'done', 'failed')),
  attempts         INTEGER      NOT NULL DEFAULT 1,
  last_error       TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Serves retention cleanup
CREATE INDEX IF NOT EXISTS idx_webhook_events_created
  ON webhook_events (created_at);

-- -----------------------------------------------------------------------------
-- conversation_sessions: where a customer is in a multi-step chat flow
-- (booking, reschedule). One active session per client; expires after inactivity.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_sessions (
  client_phone     VARCHAR(20)  PRIMARY KEY,
  flow             VARCHAR(30)  NOT NULL,
  step             VARCHAR(30)  NOT NULL,
  data             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Payments (optional, per business)
-- Booking status (bookings.status) and payment status (bookings.payment_status)
-- are separate fields.
-- =============================================================================

-- Pricing + payment snapshot on the booking. Terms are copied at booking time so later
-- settings changes never alter an existing booking's amounts.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS quantity DECIMAL(10, 2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS unit VARCHAR(10);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS unit_price DECIMAL(10, 2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_amount DECIMAL(10, 2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'INR';
-- not_required | pending | partially_paid | paid | failed | refunded
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'not_required';
-- razorpay | cod | NULL (payment not required)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20);
-- full | advance | NULL
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(10);
-- { mode, advanceType, advanceValue, allowCashOnDelivery } as configured when the booking was made
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_terms JSONB;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS amount_due_now DECIMAL(10, 2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS amount_paid DECIMAL(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS amount_remaining DECIMAL(10, 2);
-- Unguessable token for the customer's payment page link (/pay/<token>)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_token VARCHAR(64);
-- Set when money was received for a booking that was cancelled (refund to handle)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_payment_token ON bookings (payment_token);
CREATE INDEX IF NOT EXISTS idx_bookings_business_created ON bookings (business_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- business_payment_settings: one row per business; no row = payment disabled
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_payment_settings (
  business_id            UUID           PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  payment_enabled        BOOLEAN        NOT NULL DEFAULT FALSE,
  payment_mode           VARCHAR(10)    NOT NULL DEFAULT 'full' CHECK (payment_mode IN ('full', 'advance')),
  advance_type           VARCHAR(10)    CHECK (advance_type IN ('percentage', 'fixed')),
  advance_value          DECIMAL(10, 2) CHECK (advance_value > 0),
  allow_cash_on_delivery BOOLEAN        NOT NULL DEFAULT FALSE,
  currency               VARCHAR(3)     NOT NULL DEFAULT 'INR',
  updated_by             UUID,
  created_at             TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_advance_settings CHECK (
    payment_mode = 'full'
    OR (advance_type = 'percentage' AND advance_value <= 100)
    OR (advance_type = 'fixed' AND advance_value IS NOT NULL)
  )
);

-- -----------------------------------------------------------------------------
-- payments: one row per Razorpay order (payment attempt) or cash collection.
-- No card or bank details are ever stored.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id           UUID           NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  business_id          UUID           NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  provider             VARCHAR(20)    NOT NULL CHECK (provider IN ('razorpay', 'cash')),
  razorpay_order_id    VARCHAR(64)    UNIQUE,
  razorpay_payment_id  VARCHAR(64)    UNIQUE,
  amount               DECIMAL(10, 2) NOT NULL CHECK (amount > 0),
  amount_paise         INTEGER        NOT NULL CHECK (amount_paise > 0),
  currency             VARCHAR(3)     NOT NULL DEFAULT 'INR',
  payment_type         VARCHAR(10)    NOT NULL CHECK (payment_type IN ('full', 'advance', 'balance')),
  -- created | paid | failed | refunded | partially_refunded
  status               VARCHAR(20)    NOT NULL DEFAULT 'created',
  failure_reason       TEXT,
  paid_at              TIMESTAMPTZ,
  -- Refund support (recorded from Razorpay refund webhooks; refunds issued from Razorpay dashboard/API)
  refund_status        VARCHAR(20),
  refunded_amount      DECIMAL(10, 2) NOT NULL DEFAULT 0,
  razorpay_refund_id   VARCHAR(64),
  created_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments (booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_business ON payments (business_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- WhatsApp Pay (in-chat order_details payments), selectable per business instead of
-- the Razorpay web link. The gateway (Razorpay/PayU/BillDesk/Zaakpay) is linked in
-- WhatsApp Manager under a "payment configuration" name.
-- -----------------------------------------------------------------------------
ALTER TABLE business_payment_settings ADD COLUMN IF NOT EXISTS online_provider VARCHAR(20) NOT NULL DEFAULT 'razorpay_link';
ALTER TABLE business_payment_settings ADD COLUMN IF NOT EXISTS whatsapp_pay_configuration VARCHAR(60);
ALTER TABLE business_payment_settings ADD COLUMN IF NOT EXISTS whatsapp_pay_gateway VARCHAR(20);
ALTER TABLE business_payment_settings DROP CONSTRAINT IF EXISTS chk_online_provider;
ALTER TABLE business_payment_settings ADD CONSTRAINT chk_online_provider CHECK (
  online_provider IN ('razorpay_link', 'whatsapp_pay')
  AND (whatsapp_pay_gateway IS NULL OR whatsapp_pay_gateway IN ('razorpay', 'payu', 'billdesk', 'zaakpay'))
);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('razorpay', 'cash', 'whatsapp_pay'));
-- reference_id sent in the order_details message (max 35 chars, unique per booking)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS wa_reference_id VARCHAR(35);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS wa_payment_configuration VARCHAR(60);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway VARCHAR(20);
-- Gateway order id and payment id reported by WhatsApp payment status webhooks / lookup API
ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_order_id VARCHAR(64);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS pg_transaction_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_wa_reference ON payments (wa_reference_id);
CREATE INDEX IF NOT EXISTS idx_payments_pending_whatsapp ON payments (provider, status, created_at);

-- Razorpay webhook deliveries already processed (idempotency)
CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
  event_id      VARCHAR(100) PRIMARY KEY,
  event         VARCHAR(60)  NOT NULL,
  received_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- Admin dashboard accounts and sessions
-- 'admin' belongs to exactly one business; 'super_admin' can view every business (read-only settings)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID          REFERENCES businesses(id) ON DELETE CASCADE,
  email           VARCHAR(255)  NOT NULL,
  password_hash   TEXT          NOT NULL,
  role            VARCHAR(20)   NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'super_admin')),
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_admin_business CHECK (role = 'super_admin' OR business_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_users_email ON admin_users (LOWER(email));

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash   CHAR(64)     PRIMARY KEY,   -- sha256 of the cookie token (raw token never stored)
  admin_id     UUID         NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf_token   CHAR(64)     NOT NULL,
  expires_at   TIMESTAMPTZ  NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions (expires_at);

-- -----------------------------------------------------------------------------
-- Geofencing details kept on the booking, so the admin location notice can also be sent
-- later (after an online payment): 'exact' | 'approximate', and the customer's maps link.
-- -----------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS location_precision VARCHAR(12);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS location_link TEXT;

-- -----------------------------------------------------------------------------
-- AI learning: an AI answer is only reused for other customers after staff approve it
-- (admin dashboard "AI answers"). Stops one customer from teaching the bot wrong facts.
-- -----------------------------------------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES admin_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_ai_answers ON messages (intent, direction, created_at DESC);

COMMIT;
