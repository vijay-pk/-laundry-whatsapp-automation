# Laundry WhatsApp Automation

WhatsApp automation for a laundry business: customers message the business number, the system detects intent (cancel / reschedule / confirm / question), updates bookings, and replies with AI answers that learn from past conversations. Third-party systems push new bookings via API and the admin gets a WhatsApp alert.

Built to become a **multi-tenant SaaS** for other businesses later — keep laundry-specific details in config (`businessKnowledge.js`, template names, env), not in core logic.

## Tech stack

- Node.js 24, CommonJS, Express 5
- PostgreSQL via `pg` (pool + parameterized queries)
- Meta WhatsApp Cloud API (Graph API **v22.0**) via `axios`
- OpenAI (`openai` SDK v7, Chat Completions JSON mode), model from `OPENAI_MODEL`
- `dotenv`, `body-parser`, `cors`; `nodemon` for dev

## Commands

```powershell
npm install
npm run dev                                   # nodemon server.js
npm start                                     # node server.js
npm test                                      # all tests (starts throwaway Postgres automatically)
npm run test:unit                             # unit tests only (no database)
npm test -- --test-name-pattern="idempotency" # filter tests by name
psql $env:DATABASE_URL -f src/models/schema.sql   # create/upgrade tables (idempotent)
```

**Always run `npm test` after code changes** (~15s, all must pass). Re-run `schema.sql` on real databases after schema changes.

## Tests (`tests/`, `node:test`, no extra framework)

- `tests/run.js` (`npm test`): starts **embedded-postgres** (devDependency, initdb `UTF8`) on a free port in a temp dir, applies `schema.sql`, runs `tests/**/*.test.js` one file at a time with `DATABASE_URL` + `NODE_ENV=test`, then stops Postgres and deletes the data dir.
  - `TEST_DATABASE_URL` (e.g. CI) uses an existing database instead — its name **must contain "test"** (tables get truncated).
- `tests/unit/` — no database: `verifyMetaSignature`, `aiService` keyword/no-key fallbacks.
- `tests/integration/` — real Postgres: `webhookEventModel`, `bookingModel`, `conversationModel`, `aiService` (OpenAI path: prompts, history, learned answers, fallbacks, retries); end-to-end `webhook.test.js`, `webhookAi.test.js` (AI replies, hand-off, learning loop, OpenAI down) and `bookingsApi.test.js` spawn the real `server.js`.
- `tests/helpers/`:
  - `db.js` — refuses to load unless `DATABASE_URL` db name contains "test" (never touches the dev DB from `.env`); `resetDb()` truncates all tables (call in `before`), `createBusiness()`, `closeDb()` (call in `after`).
  - `server.js` — `startServer({ graphUrl, env })` spawns `server.js` on a free port with fixed `TEST_ENV` (OpenAI key forced empty → keyword intents, no network); `postWebhook()` signs payloads; `postBooking()` adds the API key; `webhookPayload()`, `textMessage()`, `waitFor()`.
  - `mockGraph.js` — local Graph API mock (via `WHATSAPP_API_BASE_URL`): records sends (`sentTo(phone)`), `failNextRequests(n)` simulates Meta errors.
  - `mockOpenAI.js` — local Chat Completions mock (via SDK's `OPENAI_BASE_URL`, no app code needed). Classifies requests as `intent`/`reply` by system prompt; `onIntent(fn)` / `onReply(fn)` return `json(obj)`, `raw(str)` or `httpError(status)`; `ofKind(kind)` exposes sent prompts. Pass `OPENAI_API_KEY` + `OPENAI_BASE_URL` via `startServer({ env })`; in-process tests must set env **before** requiring `aiService` (`MODEL` read at load).
  - If you change the first words of `INTENT_PROMPT` ("You classify…"), update `mockOpenAI.js` classification.
- Webhook processing is async after the 200 → assert with `waitFor` on `webhook_events.status`, not immediately.
- New features: add tests in the matching folder; use unique phone numbers / wamids per test (files share one DB per file run).

## CI (`.github/workflows/ci.yml`)

- GitHub Actions on push to `main`/`master`, every pull request, and manual dispatch. `permissions: contents: read`; superseded runs cancelled.
- Ubuntu, Node 24 (`actions/setup-node@v7`, npm cache), `postgres:17` service container (UTF8, db `laundry_test`) → `TEST_DATABASE_URL`; embedded Postgres is not used in CI.
- Steps: `npm ci` → `node --check` on `server.js`, `src/`, `tests/` → `npm test`.
- Needs **no secrets**: Graph API and OpenAI are mocked; `OPENAI_API_KEY` forced empty. Never add real keys to CI for tests.
- `package-lock.json` must stay committed and in sync (`npm ci` fails otherwise).
- Lint workflow edits with [actionlint](https://github.com/rhysd/actionlint).

## File map

```
server.js                          Entry: env validation, middleware, routes, error handler, graceful shutdown
.env                               Secrets/config (gitignored, placeholders only)
src/config/db.js                   pg Pool + query(text, params); logs SQL + timing, never params
src/config/businessKnowledge.js    Laundry facts for the AI (services, prices, hours, area). Owner edits [EDIT] values
src/models/schema.sql              Tables: businesses, bookings, messages (+ indexes, upgrade ALTERs)
src/models/bookingModel.js         createBooking, findBookingByExternalId, getLatestBookingForClient, updateBookingStatus, logMessage
src/models/conversationModel.js    getRecentConversation, findSimilarPastAnswers (AI context / learning)
src/models/webhookEventModel.js    claimEvent, markEventDone, markEventFailed, purgeOldEvents (webhook idempotency)
src/services/whatsappService.js    sendTemplateMessage, sendTextMessage (Graph API, error hints)
src/services/aiService.js          detectIntent, generateReply, keywordIntent (fallback)
src/controllers/webhookController.js   verifyWebhook (GET), handleIncomingMessage (POST)
src/controllers/bookingController.js   createNewBooking (POST /api/bookings)
src/utils/verifyMetaSignature.js   Middleware: X-Hub-Signature-256 HMAC check on POST /webhook
src/routes/                        Empty placeholder (.gitkeep)
tests/run.js                       Test runner: embedded Postgres + schema + node --test
.github/workflows/ci.yml           CI: npm ci, syntax check, npm test against postgres:17 service
tests/unit/, tests/integration/, tests/helpers/   See Tests section
```

## Routes

| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/health` | none | inline |
| GET | `/webhook` | Meta verify token | `verifyWebhook` |
| POST | `/webhook` | `X-Hub-Signature-256` (HMAC with `META_APP_SECRET`) | `verifyMetaSignature` → `handleIncomingMessage` |
| POST | `/api/bookings` | `x-api-key: BOOKING_API_KEY` | `createNewBooking` |

## Inbound WhatsApp flow (`POST /webhook`)

0. `verifyMetaSignature`: HMAC-SHA256 of `req.rawBody` with `META_APP_SECRET`, `timingSafeEqual` vs header. Missing/invalid → 401; secret unset → 500 (fail closed). Signed body must be the raw bytes — never re-stringify `req.body`, and keep the `verify` rawBody capture in `bodyParser.json`.
1. Respond **200 immediately** (Meta retries slow/failed acks), then process.
2. Extract **all** messages from every `entry[].changes[].value.messages[]` (Meta batches); process sequentially. Status updates have none.
   - **Idempotency** (`processOnce`): atomically `claimEvent(message.id)` (wamid) in `webhook_events` **before** any work. Not claimed → duplicate, skip. Claim DB error → skip (fail closed).
   - Success → `markEventDone`; thrown error → `markEventFailed` (a later Meta redelivery may retry, max 3 attempts). `markEventDone` failure must never mark failed.
   - Stuck `processing` > 10 min (crash) can be reclaimed. Ids purged after 30 days (server startup + daily).
   - Non-text types ignored (still marked done).
3. In parallel: `detectIntent(text)` + `getLatestBookingForClient(from)`.
4. `logMessage(bookingId, 'inbound', text, intent, from)`.
5. `switch (intent)`:
   - `cancel` → no booking / already Cancelled|Delivered: text explanation. Else status `Cancelled` + template `TEMPLATE_BOOKING_CANCELLED` with `[client_name, service_type]`.
   - `reschedule` → text to `ADMIN_PHONE` with client, booking, slot, message.
   - `confirm` → status `Confirmed` (skipped if no booking or closed). No reply sent.
   - default (`question`, `greeting`, `other`) → `generateReply(text, from)` → send reply. If `needsHuman`, log reply with intent `handoff` and forward to admin.
6. Every outbound message is logged with `client_phone`. Errors after the ack are logged, never thrown.

## Booking intake flow (`POST /api/bookings`)

Body: `{ clientName, clientPhone, serviceType, scheduledTime (ISO 8601), pickupAddress?, businessId?, externalId? }`
Optional header `Idempotency-Key` (alternative to `externalId`; if both sent they must match).

1. `requireApiKey` (sha256 + `timingSafeEqual`) → 401 missing / 403 wrong.
2. Validate → 400 with `details[]`.
3. `businessId` from body or `DEFAULT_BUSINESS_ID`.
4. `createBooking` (phone stored digits-only). **Idempotent** when a key is sent: `INSERT ... ON CONFLICT (business_id, external_id) DO NOTHING`; `null` result → `findBookingByExternalId`:
   - same details (phone, name, service, address, scheduled instant) → **200** `{ duplicate: true, data: existing, notification: { sent: false, skipped } }`, no second admin alert
   - different details → **409** `{ bookingId }`
   - no key → no dedupe (every request creates a booking). Keys are scoped per business, max 255 chars.
5. Template `laundry_booking_alert` to `ADMIN_PHONE` with `[clientName, serviceType, formatted scheduledTime]` (formatted in `TIMEZONE`).
6. **201** `{ success, duplicate: false, data: booking, notification: { sent, messageId | error } }`. WhatsApp failure does **not** fail the request (prevents duplicate bookings from caller retries).

## AI + self-learning (`aiService.js`)

- `detectIntent` → one of `cancel | reschedule | confirm | question | greeting | other`. temperature 0, JSON mode. Falls back to `keywordIntent` if no key or API error.
- `generateReply` prompt = rules + `businessKnowledge` (source of truth) + similar past Q&A. Messages = last 10 messages with this client + current text. Returns `{ reply, needsHuman }`; any failure → fallback reply + `needsHuman: true`.
- **Learning** = `findSimilarPastAnswers`: full-text search (`to_tsquery` OR of words) over past inbound `question` messages from all clients, paired with the next outbound reply to the same client within 10 min, only if that reply's intent is `question`/`greeting` (hand-offs excluded). Top 5 by `ts_rank` become examples.
- Correcting wrong answers: edit `businessKnowledge.js` (prompt says it beats past answers). Bad past rows can also be deleted from `messages`.
- No OpenAI key (or `sk-replace…` placeholder) → keyword intents + fallback reply + admin hand-off.

## Database (`src/models/schema.sql`)

- `businesses(id uuid, name, whatsapp_number unique, created_at)`
- `bookings(id uuid, business_id → businesses CASCADE, client_phone, client_name, service_type, status default 'Pending', pickup_address, scheduled_time timestamptz, external_id, created_at)`
  - `external_id`: caller's idempotency key, `UNIQUE (business_id, external_id)` (NULLs never conflict)
  - status free-form VARCHAR(50) (used: Pending, Confirmed, Cancelled, Delivered) so other business types can define their own
- `messages(id uuid, booking_id → bookings SET NULL nullable, business_id → businesses nullable, client_phone, direction CHECK inbound|outbound, content, intent, created_at)`
  - intents stored: AI intents above + `handoff` for outbound hand-off replies; templates logged as `[template:<name>]`
- `webhook_events(wa_message_id PK, status CHECK processing|done|failed, attempts, last_error ≤500 chars, created_at, updated_at)` — webhook dedupe
- Indexes: bookings `(business_id, client_phone, created_at DESC)`, `(client_phone, created_at DESC)`; messages `(booking_id, created_at)`, `(client_phone, created_at)`, GIN full-text on `content`; webhook_events `(created_at)`.
- Schema file is idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `PORT` | no (3000) | HTTP port |
| `NODE_ENV` | no | `production` hides stacks + SQL logs |
| `WEBHOOK_VERIFY_TOKEN` | yes | Meta webhook verification |
| `GRAPH_API_TOKEN` | yes | Meta access token |
| `PHONE_NUMBER_ID` | yes | WhatsApp sender phone number ID |
| `META_APP_SECRET` | yes | App secret (App settings > Basic) for webhook signature verification |
| `DATABASE_URL` | yes | Postgres, **UTF8 encoding required** (₹, emoji, Indic scripts); add `?sslmode=require` for hosted DBs |
| `BOOKING_API_KEY` | yes | Auth for `/api/bookings` |
| `OPENAI_API_KEY` | no | AI; without it keyword fallback |
| `OPENAI_MODEL` | no (`gpt-4o-mini`) | OpenAI model |
| `ADMIN_PHONE` | no (features disabled) | Admin alerts, reschedule, hand-offs (digits with country code) |
| `TEMPLATE_BOOKING_CANCELLED` | no (`booking_cancelled`) | Cancel confirmation template |
| `DEFAULT_BUSINESS_ID` | no | Business for bookings without `businessId` |
| `TIMEZONE` | no (UTC) | Date format in admin alerts |
| `DB_POOL_MAX` | no (10) | Pool size |
| `WHATSAPP_API_BASE_URL` | no (Graph v22.0 URL) | Override Graph API host — tests only (mock) |
| `TEST_DATABASE_URL` | no | `npm test` uses this DB instead of embedded Postgres (name must contain "test") |

## Meta WhatsApp requirements

- Templates to create + get approved (language `en_US`):
  - `booking_cancelled` — 2 body vars: `{{1}}` name, `{{2}}` service
  - `laundry_booking_alert` — 3 body vars: `{{1}}` client name, `{{2}}` service, `{{3}}` scheduled time
- **24-hour rule**: `sendTextMessage` only delivers within 24h of recipient's last inbound message (error `131047`). Templates work anytime. Admin text notifications (reschedule, hand-off) fail unless admin messaged the business number in last 24h.
- Test mode: recipients must be added in App Dashboard (error `131030`).
- Local dev: expose with `ngrok http 3000`, register `https://…/webhook`, subscribe to `messages` field.

## Conventions (follow these)

- **SQL**: parameterized only (`$1`), never string-interpolate values. All DB access in `src/models/`.
- **Errors**: throw `Error` with `.status` (400/404/500/502); `server.js` error handler reads `err.status`. Models map pg codes (`22P02`→400, `23503`→404). Controllers call `next(err)`.
- **Phones**: stored and compared as digits only with country code (`919876543210`), same as webhook `from`.
- **PII / secrets**: log phones masked (`***1234`); never log tokens, API keys, message bodies from WhatsApp service, or SQL params.
- **Webhook**: ack 200 first; side-effect failures (logging, admin notify) must not block customer replies.
- **Laundry-specific** values live in `businessKnowledge.js`, env, or constants at top of controllers — not deep in logic.
- Comment style: numbered section banners (`// ---- 1. Section ----`), JSDoc on exported functions.
- Keep files < 500 lines. Add routes to `server.js` (or `src/routes/` once it grows).

## Known gaps / TODO

1. **Idempotency edges**: retrying a *failed* webhook event can resend a reply if the failure happened after sending. `/api/bookings` duplicates never re-send an admin alert, even if the first alert failed. Callers that send no `externalId`/`Idempotency-Key` are not deduplicated.
2. **Multi-tenant scoping**: resolve business from `value.metadata.phone_number_id`; pass `businessId` to `getLatestBookingForClient`, `logMessage` (`messages.business_id` not yet written), and `findSimilarPastAnswers`; per-business knowledge + API keys.
3. **Admin notifications**: replace text with approved templates (e.g. `reschedule_alert`, `handoff_alert`) to avoid 24h failures.
4. **Learning quality**: learn from staff/admin manual replies (best signal); optional review/approval of reused answers; consider pgvector embeddings instead of full-text.
5. **Non-text messages** (voice, image, buttons) ignored.
6. **Test gaps**: AI tests use a mock model — real OpenAI answer quality/prompt behaviour is not tested; OpenAI timeout (15s) path untested. CI not yet run on GitHub (project is not a git repo yet) — first push will be its first real run. `embedded-postgres` is pinned to `18.4.0-beta.17` (its npm `latest` tag).
7. `confirm` intent sends no reply to customer.
