# Laundry WhatsApp Automation

WhatsApp automation for a laundry business: customers message the business number to **book pickups in chat** (menu → service → time slot → address → instructions → confirm), **track orders**, reschedule or cancel, and ask questions answered by AI that learns from past conversations. Staff update order status via API and customers are notified on WhatsApp. Third-party systems can also push bookings via API; the admin gets WhatsApp alerts.

Built to become a **multi-tenant SaaS** for other businesses later — keep laundry-specific details in config (`businessKnowledge.js`, `orderStatuses.js`, template names, env), not in core logic.

## Tech stack

- Node.js 24, CommonJS, Express 5
- PostgreSQL via `pg` (pool + parameterized queries)
- Meta WhatsApp Cloud API (Graph API **v22.0**) via `axios` — text, templates, interactive buttons/lists
- OpenAI (`openai` SDK v7, Chat Completions JSON mode), model from `OPENAI_MODEL`
- `dotenv`, `body-parser`, `cors`; `nodemon` for dev; `embedded-postgres` (dev) for tests + local DB

## Commands

```powershell
npm install
npm run db:local                              # local Postgres in .localdb/ (port 5433); keep terminal open
npm run db:setup                              # apply schema + ensure business row on DATABASE_URL (e.g. Supabase)
npm run dev                                   # nodemon server.js
npm start                                     # node server.js
npm test                                      # all tests (starts throwaway Postgres automatically)
npm run test:unit                             # unit tests only (no database)
npm test -- --test-name-pattern="idempotency" # filter tests by name
ngrok http 3000                               # public HTTPS URL for Meta webhook (local dev)
```

**Always run `npm test` after code changes** (~20s, all must pass). Run `npm run db:setup` (or restart `db:local`) after schema changes.

## Local run (test number + ngrok)

1. Terminal 1: `npm run db:local` → prints `DATABASE_URL` + `DEFAULT_BUSINESS_ID` (already in `.env` for this machine).
2. Terminal 2: `npm run dev`.
3. Terminal 3: `ngrok http 3000` (needs `ngrok config add-authtoken <token>` once). Free URL changes on every restart → update Meta webhook URL each time.
4. Meta App Dashboard → WhatsApp → Configuration: Callback URL `https://<ngrok>/webhook`, Verify token = `WEBHOOK_VERIFY_TOKEN`, subscribe **messages**.
5. `.env`: `GRAPH_API_TOKEN`, `PHONE_NUMBER_ID`, `META_APP_SECRET` from the app; `ADMIN_PHONE`. Test number only delivers to numbers added under API Setup → "To" (max 5).
6. Temporary access token expires in 24h → use a System User token for anything longer. Switching to a real number: new `PHONE_NUMBER_ID` (+ token), templates re-approved under the real WABA if different.

## Tests (`tests/`, `node:test`, no extra framework)

- `tests/run.js` (`npm test`): starts **embedded-postgres** (initdb `UTF8`) on a free port in a temp dir, applies `schema.sql`, runs `tests/**/*.test.js` one file at a time with `DATABASE_URL` + `NODE_ENV=test`, then stops Postgres and deletes the data dir.
  - `TEST_DATABASE_URL` (e.g. CI) uses an existing database instead — its name **must contain "test"** (tables get truncated).
- `tests/unit/` — no database: `verifyMetaSignature`, `aiService` keyword/no-key fallbacks, `slotService` (timezones, closed days, lead time, limits), `geo` (Haversine, radius config, boundary).
- `tests/integration/geofence.test.js` — server with `BUSINESS_LAT/LNG` set: location request, typed text rejected, ~10 km rejected + recorded, ~2 km confirmed + admin map link. `TEST_ENV` clears `BUSINESS_LAT/LNG` so other tests never inherit geofencing from `.env`.
- `tests/integration/` — real Postgres: models, `aiService` (OpenAI path), end-to-end (spawn real `server.js`): `webhook.test.js`, `webhookAi.test.js`, `bookingFlow.test.js` (chat booking by taps/typing/location, saved address, invalid input, stop/menu/expiry, duplicate confirm, reschedule, tracking), `bookingsApi.test.js` (intake, idempotency, PATCH status).
- `tests/helpers/`:
  - `db.js` — refuses to load unless `DATABASE_URL` db name contains "test"; `resetDb()` truncates all tables (call in `before`; add new tables to its TRUNCATE), `createBusiness()`, `closeDb()` (call in `after`).
  - `server.js` — `startServer({ graphUrl, env })` spawns `server.js` with fixed `TEST_ENV` (OpenAI key empty, `TIMEZONE=Asia/Kolkata`); `postWebhook()` signs payloads; `postBooking()`; `webhookPayload(messages, { profileName })`, `textMessage()`, `tapMessage(id, from, replyId, title, 'button_reply'|'list_reply')`, `locationMessage()`, `waitFor()`.
  - `mockGraph.js` — Graph API mock (via `WHATSAPP_API_BASE_URL`): `sentTo(phone)` bodies (text / template / interactive), `failNextRequests(n)`.
  - `mockOpenAI.js` — Chat Completions mock (via `OPENAI_BASE_URL`): `onIntent(fn)` / `onReply(fn)` return `json()`, `raw()`, `httpError()`; `ofKind(kind)`. In-process tests set env **before** requiring `aiService`. If `INTENT_PROMPT`'s first words ("You classify…") change, update the mock.
- Webhook processing is async after the 200 → assert with `waitFor` on `webhook_events.status`. Slot-dependent tests call `listSlots()` in-process → set `process.env.TIMEZONE = TEST_ENV.TIMEZONE`.
- New features: add tests in the matching folder; unique phone numbers / wamids per test.

## CI (`.github/workflows/ci.yml`)

- GitHub Actions on push to `main`/`master`, PRs, manual dispatch. `permissions: contents: read`; superseded runs cancelled.
- Ubuntu, Node 24, `postgres:17` service (UTF8, `laundry_test`) → `TEST_DATABASE_URL`.
- Steps: `npm ci` → `node --check` on `server.js`, `src/`, `tests/`, `scripts/` → `npm test`.
- Needs **no secrets** (Graph + OpenAI mocked). `package-lock.json` must stay in sync. Lint workflow edits with actionlint.

## File map

```
server.js                              Entry: env validation, middleware, routes, error handler, purge jobs, shutdown
.env                                   Secrets/config (gitignored)
src/config/db.js                       pg Pool + query(text, params); logs SQL + timing, never params
src/config/businessKnowledge.js        Business facts: services (id/name/price), pickupSlots, closed days, policies. [EDIT] values
src/config/orderStatuses.js            Status lifecycle + customer message per status; CHANGEABLE / CLOSED sets
src/models/schema.sql                  All tables (idempotent)
src/models/bookingModel.js             createBooking, findBookingByExternalId, getBookingById, getLatestBookingForClient,
                                       updateBookingStatus, updateBookingSchedule, logMessage
src/models/conversationModel.js        getRecentConversation, findSimilarPastAnswers (AI context / learning)
src/models/sessionModel.js             getActiveSession (30-min TTL), saveSession, clearSession, purgeExpiredSessions
src/models/webhookEventModel.js        claimEvent, markEventDone, markEventFailed, purgeOldEvents (webhook idempotency)
src/services/whatsappService.js        sendTemplateMessage, sendTextMessage, sendButtonsMessage (≤3), sendListMessage (≤10 rows)
src/services/replyService.js           replyText/replyButtons/replyList (send + log), safeLog, notifyAdmin (text), maskPhone
src/services/notificationService.js    alertAdminNewBooking (template), notifyCustomerStatus (template or text)
src/services/bookingFlow.js            Chat flows (booking, reschedule), welcome menu, bookingRef
src/services/slotService.js            listSlots / findSlot in TIMEZONE (no date library)
src/services/serviceAreaService.js     Geofencing side effects: recordRejectedRequest, notifyAdminGeofencedBooking
src/utils/geo.js                       haversineKm, parseCoordinates, getServiceArea (env), checkServiceArea, mapsLink
src/services/aiService.js              detectIntent, generateReply, keywordIntent (fallback)
src/controllers/webhookController.js   verifyWebhook (GET), handleIncomingMessage (POST): parsing, routing, intents
src/controllers/bookingController.js   createNewBooking (POST), updateStatus (PATCH)
src/utils/verifyMetaSignature.js       Middleware: X-Hub-Signature-256 HMAC check
src/utils/formatDate.js                formatDateTime in TIMEZONE
scripts/localDb.js, scripts/setupDb.js Local embedded Postgres; schema + business setup for any DATABASE_URL
tests/, .github/workflows/ci.yml       See Tests / CI
```

## Routes

| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/health` | none | inline |
| GET | `/webhook` | Meta verify token | `verifyWebhook` |
| POST | `/webhook` | `X-Hub-Signature-256` (`META_APP_SECRET`) | `verifyMetaSignature` → `handleIncomingMessage` |
| POST | `/api/bookings` | `x-api-key: BOOKING_API_KEY` | `createNewBooking` |
| PATCH | `/api/bookings/:id/status` | `x-api-key: BOOKING_API_KEY` | `updateStatus` |

## Inbound WhatsApp flow (`POST /webhook`)

0. `verifyMetaSignature`: HMAC of `req.rawBody`; invalid → 401; secret unset → 500. Never re-stringify `req.body`.
1. Respond **200 immediately**, then process.
2. `extractMessages`: all `entry[].changes[].value.messages[]` + sender profile name from `value.contacts`. Sequential.
   - **Idempotency** (`processOnce`): `claimEvent(wamid)` before any work; duplicate → skip; DB error → skip. Success → done; throw → failed (redelivery retries, max 3). Stuck `processing` > 10 min reclaimable. Purge after 30 days.
3. `parseInput` → `text` | `choice` (interactive `button_reply`/`list_reply`, template quick-reply `button`) | `location` | `other`.
4. **Active session** (`conversation_sessions`, < 30 min old) → log inbound (intent `booking_flow`) → `bookingFlow.handleFlowMessage`. Returns false (and clears session) for `menu` words / `menu_*` taps → continue as fresh message.
5. No session:
   - `choice` → `menu_book` start booking · `menu_track` status · `menu_prices` price list · anything else "That menu has expired" + welcome menu.
   - `other` (image, voice, …) → "only text for now".
   - `text` → `menu|start` = greeting (no AI), else `detectIntent` ∥ `getLatestBookingForClient`, log, then:
     - `greeting` → welcome menu buttons (`menu_book`, `menu_track`, `menu_prices`) with profile name
     - `book` → booking flow (prefills name/address from latest booking or profile name)
     - `status` → latest booking ref, status, status message
     - `cancel` → none: explain · Cancelled/Delivered: "already …" · not changeable (after pickup): hand-off + admin text · else `Cancelled` + template `TEMPLATE_BOOKING_CANCELLED`
     - `reschedule` → no active booking: suggest book · after pickup: hand-off + admin · else reschedule flow
     - `confirm` → status `Confirmed` (no reply)
     - default (`question`, `other`) → `generateReply`; `needsHuman` → log as `handoff` + admin text
6. Every outbound message logged with `client_phone` + intent. Errors after the ack are logged, never thrown.

## Chat flows (`bookingFlow.js`)

- **Booking** steps (session `flow=booking`): `service` (list `svc_<id>`) → `location` (**geofencing**, only when `BUSINESS_LAT`/`BUSINESS_LNG` are valid) → `slot` (list `slot_YYYY-MM-DD_HHMM`) → `address_choice` (buttons `addr_saved`/`addr_new`, only if a previous booking has an address) or `address` (text ≥ 10 chars or shared location → "name, address (maps link)") → `name` (skipped if known; 2–60 chars) → `notes` (button `notes_skip` or text ≤ 500) → `confirm` (buttons `confirm_yes` / `confirm_restart` / `confirm_no`).
  - Confirm: re-checks slot still offered, needs `DEFAULT_BUSINESS_ID`, `createBooking(... source 'whatsapp', status 'Confirmed')`, clears session, confirmation text with ref `#<first 8 of id>`, `alertAdminNewBooking`.
- **Geofencing** (`location` step): `sendLocationRequest` text; only a native WhatsApp location is accepted (typed text → re-ask, counts as a wrong answer). Haversine distance to the store:
  - `> MAX_DELIVERY_RADIUS_KM` → session cleared, exact message "Sorry, your location is outside our {radius}km service radius. We cannot process this booking.", request saved as booking `status Cancelled`, `booking_state 'rejected'` with coordinates + distance (skipped if no `DEFAULT_BUSINESS_ID`).
  - `<=` radius → `data.geo` kept; address step asks only house/flat/landmark; summary shows distance; confirmed booking saved with `latitude/longitude/distance_km` + `booking_state 'confirmed'`; admin gets the template alert **and** a text with name, phone, service, slot, distance, Google Maps link (`https://www.google.com/maps/search/?api=1&query=LAT,LNG`). Admin is notified at confirmation (name/slot known then), not when the location is shared.
  - Location shared outside any flow → guidance reply ("send *book*").
- **Reschedule** (`flow=reschedule`, `data.bookingId`): `slot` → `updateBookingSchedule` → confirmation + admin text.
- Typed answers work everywhere: option number ("2"), option title, yes/no words. Wrong answer → re-ask; 3 wrong → session cleared.
- Inside a flow `stop|exit|quit|abort|cancel` ends the flow (does **not** cancel existing bookings); `menu` leaves it.
- Slot ids are validated against `listSlots()` when picked and again at confirm (past/closed/forged ids rejected). `data.offeredSlots` stores what was shown (for typed numbers).
- Button titles ≤ 20 chars, list row titles ≤ 24, ≤ 3 buttons, ≤ 10 rows (`whatsappService` truncates). Interactive messages only inside the 24h window (always true: customer just messaged).
- Session data changes must stay JSON-serializable; renaming a step or service `id` breaks in-progress sessions (30 min).

## Order status (`orderStatuses.js`, `PATCH /api/bookings/:id/status`)

- Statuses: `Pending → Confirmed → Out for Pickup → Picked Up → Processing → Ready → Out for Delivery → Delivered`, plus `Cancelled`. Customer can change/cancel by chat only in `Pending|Confirmed|Out for Pickup`.
- PATCH body `{ status }` → 400 unknown status · 404 unknown booking · same status → 200 `skipped` (no message) · else update + `notifyCustomerStatus` (template `TEMPLATE_ORDER_STATUS` "Hi {{1}}, {{2}}" if set — works after 24h — else text) → 200 `{ data, notification }`. WhatsApp failure never fails the request.

## Booking intake API (`POST /api/bookings`)

Body `{ clientName, clientPhone, serviceType, scheduledTime, pickupAddress?, businessId?, externalId? }` (or `Idempotency-Key` header).
Validate → 400 · business from body or `DEFAULT_BUSINESS_ID` · idempotent with key: same details → 200 `duplicate: true` (no second alert), different → 409 · new → 201 + `alertAdminNewBooking` (failure reported, not thrown).

## AI + self-learning (`aiService.js`)

- `detectIntent` → `book | status | cancel | reschedule | confirm | question | greeting | other` (temperature 0, JSON). Keyword fallback order: cancel, reschedule, confirm, greeting (< 25 chars), status, book, question.
- `generateReply` = rules + `businessKnowledge` + similar past Q&A + last 10 messages → `{ reply, needsHuman }`; failures → fallback + `needsHuman`.
- **Learning** (`findSimilarPastAnswers`): past inbound `question` messages paired with the next outbound reply ≤ 10 min whose intent is `question`/`greeting`. Menus (`menu`), flow messages (`booking_flow`), `status_update`, `handoff` are never learned.

## Database (`src/models/schema.sql`)

- `businesses(id, name, whatsapp_number unique, created_at)`
- `bookings(id, business_id, client_phone, client_name, service_type, status default 'Pending', pickup_address, scheduled_time, external_id, notes, source 'api'|'whatsapp', latitude DECIMAL(9,6), longitude DECIMAL(9,6), distance_km DECIMAL(7,2), booking_state default 'pending' ('awaiting_location'|'confirmed'|'rejected'), created_at, updated_at)` — pg returns DECIMAL as strings; `UNIQUE (business_id, external_id)`
- `messages(id, booking_id?, business_id?, client_phone, direction, content, intent, created_at)` — intents: AI intents + `handoff`, `menu`, `booking_flow`, `status_update`, `unsupported`; taps logged as `[tap] Title`, locations `[location] lat,long`, templates `[template:name]`
- `webhook_events(wa_message_id PK, status, attempts, last_error, created_at, updated_at)`
- `conversation_sessions(client_phone PK, flow, step, data jsonb, updated_at)`
- DB must be **UTF8**. Schema idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `PORT` | no (3000) | HTTP port |
| `NODE_ENV` | no | `production` hides stacks + SQL logs; `test` hides SQL logs |
| `WEBHOOK_VERIFY_TOKEN` | yes | Meta webhook verification (you choose it) |
| `GRAPH_API_TOKEN` | yes | Meta access token (temporary = 24h; System User token for long-term) |
| `PHONE_NUMBER_ID` | yes | WhatsApp sender phone number ID (changes when moving from test to real number) |
| `META_APP_SECRET` | yes | App secret for webhook signatures |
| `DATABASE_URL` | yes | Postgres (UTF8). Local: `db:local`; Supabase: add `?sslmode=require` |
| `BOOKING_API_KEY` | yes | Auth for `/api/bookings*` |
| `DEFAULT_BUSINESS_ID` | yes for chat booking | Business chat + API bookings belong to (`db:local` / `db:setup` print it) |
| `ADMIN_PHONE` | no (features disabled) | Admin alerts, reschedules, hand-offs |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | no / `gpt-4o-mini` | AI intents + replies; without key keyword fallback |
| `TEMPLATE_BOOKING_CANCELLED` | no (`booking_cancelled`) | Cancel confirmation template |
| `TEMPLATE_ORDER_STATUS` | no (text) | Status update template "Hi {{1}}, {{2}}" |
| `TIMEZONE` | no (UTC) | Pickup slots + dates in messages |
| `BUSINESS_LAT` / `BUSINESS_LNG` | no (geofencing off) | Store location, decimal degrees; both valid → location check in booking flow |
| `MAX_DELIVERY_RADIUS_KM` | no (5) | Service radius for geofencing |
| `DB_POOL_MAX` | no (10) | Pool size |
| `LOCAL_DB_PORT` | no (5433) | `db:local` port |
| `WHATSAPP_API_BASE_URL` | no | Graph API host override — tests only |
| `TEST_DATABASE_URL` | no | `npm test` external DB (name must contain "test") |

## Meta WhatsApp requirements

- Templates to create + approve (`en_US`): `booking_cancelled` (`{{1}}` name, `{{2}}` service) · `laundry_booking_alert` (`{{1}}` name, `{{2}}` service, `{{3}}` time) · optional `TEMPLATE_ORDER_STATUS` (`{{1}}` name, `{{2}}` status text).
- **24-hour rule**: text/interactive only within 24h of recipient's last message (`131047`). Admin text notifications (reschedule, hand-off, cancel-after-pickup) need the admin to have messaged the business number in 24h. Status updates after 24h need `TEMPLATE_ORDER_STATUS`.
- Test number: recipients must be added in API Setup (`131030`).

## Conventions (follow these)

- **SQL**: parameterized only. All DB access in `src/models/`.
- **Errors**: `Error` with `.status`; models map pg codes (`22P02`→400, `23503`→404); controllers `next(err)`.
- **Phones**: digits only with country code, same as webhook `from`.
- **PII / secrets**: mask phones in logs (`***1234`); never log tokens, keys, SQL params.
- **Webhook**: ack 200 first; notifications/logging failures must not block customer replies; send customer messages via `replyService` so they are logged.
- **Business-specific** values in config/env, not in flow logic. New chat step = step handler + prompt function + test in `bookingFlow.test.js`.
- Comment style: numbered section banners, JSDoc on exports. Files < 500 lines.

## Roadmap (user's plan) / known gaps

- **Phase 1 (MVP) — done**: chat booking, slots, instructions (text), reschedule, tracking, status updates API, admin alerts.
- **Phase 1 remaining**: photo/voice-note intake (media download + storage), "add items / CHANGE" for existing orders, driver live-tracking link, delay notifications, invoice PDF.
- **Phase 2 (operations)**: payments (Razorpay/Stripe links + reminders), admin dashboard, staff/driver assignment, QC checklist, route grouping, inventory alerts, subscriptions.
- **Phase 3 (intelligence)**: sentiment → admin escalation, capacity prediction, dynamic pricing, learning from staff replies, pgvector.
- **Phase 4 (growth / SaaS)**: abandoned booking recovery, re-engagement, referrals, NPS after delivery, loyalty, multi-tenant (resolve business by `metadata.phone_number_id`; scope sessions, bookings, learning per business), white-label, roles, shared inbox, analytics.
- Gaps: sessions keyed by phone only (single tenant); concurrent taps from one customer can race on a session; admin notifications are text (24h rule); retrying a failed webhook event can resend a reply; AI tests use a mock model; `embedded-postgres` pinned to `18.4.0-beta.17`.
