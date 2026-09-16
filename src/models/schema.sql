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

COMMIT;
