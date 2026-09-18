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
npm run admin:create -- --email you@x.com     # dashboard login for DEFAULT_BUSINESS_ID (--business <uuid>, --role super_admin)
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
- `tests/unit/` — no database: `verifyMetaSignature`, `aiService` keyword/no-key fallbacks, `slotService` (timezones, closed days, lead time, limits), `geo` (Haversine, radius config, boundary), `mapsLink` (link formats, host allowlist, place queries), `locationResolver` (injected fetch: redirects, SSRF block, geocoding, cache).
- `tests/integration/whatsappPay.test.js` — order_details payload, webhook success/failure/duplicates/wrong amount, "pay" resend, lookup recovery on track, refunds, send failure, provider switch keeps terms, no cash on pending, no status step-back, paid cancel ⇒ refund. `mockGraph` supports `setPaymentLookup(ref, payments)` and `failNextOrderDetails(n)`.
- `tests/integration/payments.test.js` — spec TEST 1–9 end-to-end (chat → /pay → mock Razorpay → verify/webhooks), invalid signatures, lost callback recovery, Razorpay outage, cancelled-then-paid refund flag, refunds, COD, admin location notice after an online payment. `tests/integration/adminDashboard.test.js` — login/cookies/throttle (per IP+email and per-IP spraying), AI answers approval (CSRF, super admin read-only), CSRF, per-business isolation (TEST 8), super admin read-only, cash ownership. `tests/unit/payments.test.js` — money math, settings validation, signatures, passwords. `tests/helpers/mockRazorpay.js` — orders/payments/capture API + `pay()`, `checkoutCallback()`, signed `webhook()`, `failNextRequests()`; `TEST_ENV` clears Razorpay keys/PUBLIC_BASE_URL so tests never use real keys.
- `tests/integration/geofence.test.js` — server with `BUSINESS_LAT/LNG` set: location request, typed text rejected, ~10 km rejected + recorded, ~2 km confirmed + admin map link. `TEST_ENV` clears `BUSINESS_LAT/LNG` so other tests never inherit geofencing from `.env`.
- `tests/integration/` — real Postgres: models, `aiService` (OpenAI path), end-to-end (spawn real `server.js`): `webhook.test.js`, `webhookAi.test.js`, `bookingFlow.test.js` (chat booking by taps/typing/location, saved address, invalid input, stop/menu/expiry, duplicate confirm, duplicate booking guard (keep / book another / closed order / unpaid pay link), reschedule, tracking), `bookingsApi.test.js` (intake, idempotency, PATCH status), `orderActions.test.js` (several orders: picker by tap/number/ref, cancel confirmation, other customer's ids rejected, status re-check, reschedule pick, ref in status updates, confirm picks among Pending only), `concurrency.test.js` (`withLock` per key; simultaneous messages from one customer: retries counted, one booking from 3 Confirm taps).
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
src/config/db.js                       pg Pool + query(text, params); logs SQL + timing, never params; withTransaction; withLock (advisory lock, own pool); closePools
src/config/businessKnowledge.js        Business facts: services (id/name/price), pickupSlots, closed days, policies. [EDIT] values
src/config/orderStatuses.js            Status lifecycle + customer message per status; CHANGEABLE / CLOSED sets; bookingRef
src/models/schema.sql                  All tables (idempotent)
src/models/bookingModel.js             createBooking, findBookingByExternalId, getBookingById, getLatestBookingForClient,
                                       getActiveBookingsForClient, findClientBookingByRef (both phone-scoped), findDuplicateBooking (customer lookups skip booking_state 'rejected'),
                                       updateBookingStatus, updateBookingSchedule, logMessage
src/models/conversationModel.js        getRecentConversation, findSimilarPastAnswers (approved answers only), listAiAnswers, setAnswerApproval
src/models/sessionModel.js             getActiveSession (30-min TTL), saveSession, clearSession, purgeExpiredSessions
src/models/webhookEventModel.js        claimEvent, markEventDone, markEventFailed, purgeOldEvents (webhook idempotency)
src/services/whatsappService.js        sendTemplateMessage, sendTextMessage, sendButtonsMessage (≤3), sendListMessage (≤10 rows)
src/services/replyService.js           replyText/replyButtons/replyList (send + log), safeLog, notifyAdmin (text, never throws), maskPhone
src/services/notificationService.js    alertAdminNewBooking (template), notifyCustomerStatus (template or text)
src/services/bookingFlow.js            Chat flows (booking, reschedule), welcome menu, registerFlow (other services' session flows)
src/services/orderActions.js           Track/cancel/reschedule/confirm the right order (ref · single · picker), cancel confirmation
src/services/duplicateGuard.js         Chat confirm: same service + pickup time already open → ask keep / book another
src/services/slotService.js            listSlots / findSlot in TIMEZONE (no date library)
src/services/serviceAreaService.js     Geofencing side effects: recordRejectedRequest, notifyAdminGeofencedBooking
src/utils/geo.js                       haversineKm, parseCoordinates, getServiceArea (env), checkServiceArea, mapsLink
src/utils/mapsLink.js                  Google Maps link parsing: extractMapsUrl, parseCoordinatesFromUrl, placeQueriesFromUrl, host allowlist
src/services/locationResolver.js       resolveMapsLink: coords in link → expand short link → geocode place name (Nominatim)
src/services/aiService.js              detectIntent, generateReply, keywordIntent (fallback)
src/controllers/webhookController.js   verifyWebhook (GET), handleIncomingMessage (POST): parsing, routing, intents
src/controllers/bookingController.js   createNewBooking (POST), updateStatus (PATCH)
src/utils/verifyMetaSignature.js       Middleware: X-Hub-Signature-256 HMAC check
src/utils/formatDate.js                formatDateTime in TIMEZONE
scripts/localDb.js, scripts/setupDb.js Local embedded Postgres; schema + business setup for any DATABASE_URL
scripts/createAdmin.js                 Create admin / super_admin dashboard accounts
src/services/bookingCheckout.js        Chat booking: quantity parsing, payment summary/buttons, finalizeBooking (none | razorpay | cod)
src/services/paymentService.js         Payment options/quote, Razorpay checkout, verify, sync (reconcile), webhooks, cash recording
src/services/razorpayService.js        Razorpay REST (orders, payments, capture) + checkout/webhook signature verification
src/services/whatsappPayService.js     WhatsApp Pay: order_details request, payment status webhooks, lookup sync, pay reminders
src/models/paymentSettingsModel.js     Per-business settings (validate/get/save; no row = payment off)
src/models/paymentModel.js             payments rows, booking payment updates (row locks), webhook event dedupe, admin bookings list
src/models/adminModel.js               admin_users, admin_sessions (sha256 token hash), businesses + settings overview
src/middleware/adminAuth.js            Session cookie, requireAdmin/requireBusinessAdmin, CSRF check, login throttling
src/controllers/payController.js       /pay/:token page + order/verify/sync JSON, /webhooks/razorpay
src/controllers/adminController.js     /admin login/logout, bookings, payment settings, cash received, AI answers approve/unapprove
src/routes/payRoutes.js, adminRoutes.js
src/views/html.js, payPage.js, adminPages.js   Server-rendered HTML (esc() everything), CSP with nonces
src/utils/money.js, passwords.js        Paise math + calculatePaymentTerms; scrypt hashing + random tokens
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
| GET | `/pay/:token` | unguessable 64-hex token (from WhatsApp link) | payment page / receipt (syncs with Razorpay first) |
| POST | `/pay/:token/order` · `/verify` · `/sync` | token | create/reuse Razorpay order · verify checkout signature · reconcile |
| POST | `/webhooks/razorpay` | `X-Razorpay-Signature` (HMAC of raw body, `RAZORPAY_WEBHOOK_SECRET`) | payment/refund webhooks |
| GET/POST | `/admin/login`, `/admin/logout`, `/admin/bookings`, `/admin/bookings/:id/cash`, `/admin/payment-settings`, `/admin/ai-answers`, `/admin/ai-answers/:id/approve` · `/unapprove` (business admin only) | session cookie + CSRF | admin dashboard |

## Inbound WhatsApp flow (`POST /webhook`)

0. `verifyMetaSignature`: HMAC of `req.rawBody`; invalid → 401; secret unset → 500. Never re-stringify `req.body`.
1. Respond **200 immediately**, then process.
2. `extractMessages`: all `entry[].changes[].value.messages[]` + sender profile name from `value.contacts`. Sequential.
   - **Idempotency** (`processOnce`): `claimEvent(wamid)` before any work; duplicate → skip; DB error → skip. Success → done; throw → failed + best-effort customer reply "Sorry, something went wrong… send your message again" (Meta does **not** resend after our 200; a manual/duplicate redelivery of a failed id is retried, max 3). Stuck `processing` > 10 min reclaimable. Purge after 30 days.
   - **Per-customer lock**: `processMessage` runs inside `withLock('wa:<phone>')` (Postgres advisory lock, all instances) → one message per customer at a time, so simultaneous taps can't overwrite each other's session. Lock connections come from a separate pool (`DB_LOCK_POOL_MAX`), wait up to `DB_LOCK_TIMEOUT` then the message fails (customer gets the error reply). Razorpay webhooks / pay page don't use it (row locks there).
3. `parseInput` → `text` | `choice` (interactive `button_reply`/`list_reply`, template quick-reply `button`) | `location` | `other`.
4. **Active session** (`conversation_sessions`, < 30 min old) → log inbound (intent `booking_flow`) → `bookingFlow.handleFlowMessage`. Returns false (and clears session) for `menu` words / `menu_*` taps → continue as fresh message.
5. No session:
   - `choice` → `menu_book` start booking · `menu_track` track (see Several orders) · `menu_prices` price list · `ord_*` / `cxl_*` order taps (`handleOrderChoice`, work after session expiry) · anything else "That menu has expired" + welcome menu.
   - `other` (image, voice, …) → "only text for now".
   - `text` → `menu|start` = greeting (no AI), else `detectIntent` ∥ `getLatestBookingForClient`, log, then:
     - `greeting` → welcome menu buttons (`menu_book`, `menu_track`, `menu_prices`) with profile name
     - `book` → booking flow (prefills name/address from latest booking or profile name)
     - `status` / `cancel` / `reschedule` → `orderActions.handleOrderRequest` picks the order (see Several orders), then:
       - track: ref, service, status, status message (+ payment lines)
       - cancel: none: explain · Cancelled/Delivered: "already …" · not changeable (after pickup): hand-off + admin text · else confirmation buttons → `updateBookingStatus(id, 'Cancelled', { onlyFromStatuses: CHANGEABLE_STATUSES })` (same UPDATE re-checks status; changed meanwhile → hand-off message) + template `TEMPLATE_BOOKING_CANCELLED`
       - reschedule: no active booking: suggest book · after pickup: hand-off + admin · else reschedule flow
     - `confirm` → `handleOrderRequest` with only **Pending** orders as candidates (≥ 2 → picker `ord_confirm_<uuid>`, reply "is confirmed" after a pick; one → silent) · none Pending → latest open/any order, never moved backwards (only `Pending` becomes `Confirmed`) · unpaid online booking → payment link instead
     - default (`question`, `other`) → `generateReply`; `needsHuman` → log as `handoff` + admin text
6. Every outbound message logged with `client_phone` + intent. Errors after the ack are logged, never thrown.

## Chat flows (`bookingFlow.js`)

- **Booking** steps (session `flow=booking`): `service` (list `svc_<id>`) → `location` (**geofencing**, only when `BUSINESS_LAT`/`BUSINESS_LNG` are valid) → `slot` (list `slot_YYYY-MM-DD_HHMM`) → `address_choice` (buttons `addr_saved`/`addr_new`, only if a previous booking has an address) or `address` (text ≥ 10 chars or shared location → "name, address (maps link)") → `name` (skipped if known; 2–60 chars) → `notes` (button `notes_skip` or text ≤ 500) → `confirm` (buttons `confirm_yes` / `confirm_restart` / `confirm_no`).
  - Confirm: re-checks slot still offered, needs `DEFAULT_BUSINESS_ID`, **duplicate guard** (`findDuplicateBooking`: open order, same phone + service name + scheduled_time, any source) → step `duplicate` with buttons `dup_keep` / `dup_new` (typed 1/keep/no · 2/new/yes; `data.confirmChoice` replays the confirm tap; unpaid online original → its pay link), then `createBooking(... source 'whatsapp', status 'Confirmed')`, clears session, confirmation text with ref `#<first 8 of id>`, `alertAdminNewBooking`.
- **Geofencing** (`location` step): `sendLocationRequest` text; only a native WhatsApp location is accepted (typed text → re-ask, counts as a wrong answer). Haversine distance to the store:
  - `> MAX_DELIVERY_RADIUS_KM` → session cleared, exact message "Sorry, your location is outside our {radius}km service radius. We cannot process this booking.", request saved as booking `status Cancelled`, `booking_state 'rejected'` with coordinates + distance (skipped if no `DEFAULT_BUSINESS_ID`).
  - `<=` radius → `data.geo` kept; address step asks only house/flat/landmark; summary shows distance; confirmed booking saved with `latitude/longitude/distance_km` + `booking_state 'confirmed'`; admin gets the template alert **and** a text with name, phone, service, slot, distance, Google Maps link (`https://www.google.com/maps/search/?api=1&query=LAT,LNG`). Admin is notified at confirmation (name/slot known then), not when the location is shared; for online-payment bookings only after the payment is verified (`notifyAdminOfPayment` → `notifyAdminGeofencedBooking(booking)` from the stored `latitude/longitude/distance_km/location_precision/location_link`).
  - **Google Maps links** are accepted too (`readCustomerLocation` → `resolveMapsLink`): coordinates read from the link (`?q=`, `/search/`, `!3d!4d`, `@`, DMS) = exact; short links (`maps.app.goo.gl`) expanded with manual redirects restricted to Google hosts (SSRF-safe, 5 hops, 6s timeout); place links without coordinates geocoded via OpenStreetMap Nominatim (≤1 req/s, cached 24h, city-level results rejected) = **approximate** with uncertainty 0.5 km (street/building) or 2 km (area). Approximate decision: inside only if `distance + uncertainty ≤ radius`, outside only if `distance − uncertainty > radius`, otherwise ask for the exact 📎 location. Admin notice marks approximate and includes the customer's link.
  - Location or maps link sent outside any flow → guidance reply ("send *book*").
- **Reschedule** (`flow=reschedule`, `data.bookingId`): `slot` → re-load booking (owner + still `CHANGEABLE_STATUSES`, else explain) → `updateBookingSchedule` → confirmation + admin text.
- **Several orders** (`orderActions.js`, session `flow=order`): order = `#REF` in the text (`findClientBookingByRef`, 8 hex, any case) · else one open order · else ≥ 2 open → list `ord_<track|cancel|reschedule>_<uuid>` (step `pick`; tap, number or ref) · else latest order (closed/none messages).
  - Cancel always asks: step `cancel_confirm` (`data.bookingId`), buttons `cxl_yes_<uuid>` / `cxl_no_<uuid>` or typed yes/no; typing `cancel` there stops the flow and keeps the order.
  - Every tap re-loads the booking, checks `client_phone === from` and re-checks status (picked up meanwhile → hand-off). Never trust ids from taps.
- Typed answers work everywhere: option number ("2"), option title, yes/no words. Wrong answer → re-ask; 3 wrong → session cleared.
- Inside a flow `stop|exit|quit|abort|cancel` ends the flow (does **not** cancel existing bookings); `menu` leaves it.
- Slot ids are validated against `listSlots()` when picked and again at confirm (past/closed/forged ids rejected). `data.offeredSlots` stores what was shown (for typed numbers).
- Button titles ≤ 20 chars, list row titles ≤ 24, ≤ 3 buttons, ≤ 10 rows (`whatsappService` truncates). Interactive messages only inside the 24h window (always true: customer just messaged).
- Session data changes must stay JSON-serializable; renaming a step or service `id` breaks in-progress sessions (30 min).

## Order status (`orderStatuses.js`, `PATCH /api/bookings/:id/status`)

- Statuses: `Pending → Confirmed → Out for Pickup → Picked Up → Processing → Ready → Out for Delivery → Delivered`, plus `Cancelled`. Customer can change/cancel by chat only in `Pending|Confirmed|Out for Pickup`.
- PATCH body `{ status }` → 400 unknown status · 404 unknown booking · same status → 200 `skipped` (no message) · else update + `notifyCustomerStatus` (text "Order #REF: <status message>"; template `TEMPLATE_ORDER_STATUS` "Hi {{1}}, {{2}}" if set — works after 24h — else text) → 200 `{ data, notification }`. WhatsApp failure never fails the request.

## Payments (optional, per business)

- **Off by default** (no `business_payment_settings` row). Off ⇒ chat booking is exactly the original flow (`payment_status 'not_required'`, no quantity step). API bookings never require payment.
- Settings (admin dashboard): `payment_enabled`, `payment_mode` full|advance, `advance_type` percentage|fixed + `advance_value`, `allow_cash_on_delivery`. Enabling without Razorpay keys requires COD. Super admin: read-only overview.
- **Chat flow when enabled**: service → quantity ("5" kg / pieces, limits in `businessKnowledge.quantityLimits`) → … → summary shows Total / pay now / remaining / COD → buttons `confirm_pay` (`Pay ₹X`), `confirm_cod`, `confirm_no`. Totals = `quantity × service.unitPrice` computed server-side (`money.js`, integer paise).
  - `razorpay`: booking `status Pending`, `booking_state awaiting_payment`, `payment_status pending`, `payment_token`; WhatsApp link `PUBLIC_BASE_URL/pay/<token>`. **No confirmation or admin alert until verified payment.**
  - `cod`: booking Confirmed immediately, `payment_status pending`, `amount_remaining = total`; admin records cash in dashboard.
- **Terms snapshot**: `total_amount`, `amount_due_now`, `payment_mode`, `payment_terms` (jsonb) stored at booking time; later settings changes never alter existing bookings.
- **Booking status ≠ payment status**: `bookings.status` (order lifecycle) vs `bookings.payment_status` (`not_required|pending|partially_paid|paid|failed|refunded`).
- **Razorpay checkout** (`paymentService`): order amount from DB only (browser body ignored); one reusable order per booking/amount (Razorpay allows retries on the same order); order creation under booking row lock. Success only via (a) `/verify` with valid `HMAC(order_id|payment_id, key_secret)` + payment fetched from API (amount/order match, capture if `authorized`), (b) signed webhook `payment.captured`/`order.paid`, or (c) `sync` fetching `/orders/:id/payments`. All go through `confirmPaid` (payment row `FOR UPDATE`; already paid ⇒ no-op) ⇒ `applyPaymentToBooking` (amount_paid capped at total, `paid`/`partially_paid`, booking Confirmed — or `refund_required` if cancelled meanwhile). Notifications only after commit, customer and admin independently.
- Failure: `payment.failed` webhook or sync ⇒ payment `failed`, booking `payment_status failed` (never overrides paid); customer can retry. Closed checkout ⇒ stays `pending`.
- Webhooks: `razorpay_webhook_events` insert (event id header or sha256 of body) in the same transaction as processing ⇒ duplicates are no-ops; errors ⇒ 500 so Razorpay retries. Refund events update `refund_status/refunded_amount/razorpay_refund_id` (full refund ⇒ booking `refunded`). No refund UI.
- Admin WhatsApp: existing `laundry_booking_alert` template unchanged (3 vars) + a text with Total/Paid/Remaining/Payment status. Customer receipt text includes Razorpay payment id.
- Cash (`recordCashPayment`): only COD pending or `partially_paid` balances, own business only; a pending Razorpay payment can never be marked paid by an admin.
- Security: key secret + webhook secret server-only; Checkout gets `keyId` only. Pay page CSP allows only checkout.razorpay.com; `Referrer-Policy: no-referrer` (token in URL). No card data stored.
- Single Razorpay account from env for now; `payments.business_id` recorded on every row so per-business accounts/Route can be added later.

### WhatsApp Pay (alternative online method, `whatsappPayService.js`)

- Admin setting `online_provider`: `razorpay_link` (web /pay page, above) **or** `whatsapp_pay` (in-chat). WhatsApp Pay needs `whatsapp_pay_configuration` (exact payment configuration name from WhatsApp Manager, ≤60) + `whatsapp_pay_gateway` (razorpay|payu|billdesk|zaakpay). India only, verified business number; won't work on the free test number.
- Booking: `payment_method 'whatsapp_pay'`, Pending/`awaiting_payment`, config + gateway snapshotted in `payment_terms` (switching provider later doesn't affect it). `requestPayment` sends `interactive.type order_details` (`review_and_pay`, `reference_id` = `lb<24 hex of booking id>-<attempt>` ≤35 chars, `total_amount {value: paise, offset: 100}`, one item, expiration `WHATSAPP_PAY_EXPIRY_HOURS` default 24h). Unexpired request is reused; expired ⇒ new reference. Send failure ⇒ customer apology + admin alert, booking stays pending.
- Results: `/webhook` body `statuses[type=payment]` (same Meta signature check) ⇒ `handlePaymentStatuses` after the message loop (NOT under the per-customer lock). `transaction.status success` / `status captured` ⇒ `confirmWhatsAppPaid` (row lock on `wa_reference_id`, amount must equal `amount_paise`, idempotent; a second paid request for an already-paid booking ⇒ `refund_required` + admin alert); `failed` ⇒ failed (retry allowed); `refunds[]` ⇒ `recordRefund` by `pg_transaction_id`.
- Missed webhooks: Graph lookup `GET /<PHONE_NUMBER_ID>/payments/<config>/<reference_id>` via `syncWhatsAppPayment` — every `WHATSAPP_PAY_SYNC_MINUTES` (default 5) for requests < 48h, and on "track".
- Customer "pay" (`PAY_WORDS` in webhookController) or "yes"/track on an unpaid booking ⇒ `paymentInstruction` text (+ `remindPayment` re-sends order_details for WhatsApp Pay; Razorpay link text otherwise). `awaitingOnlinePayment` covers both providers.
- `payments` columns: `provider 'whatsapp_pay'`, `wa_reference_id` UNIQUE, `wa_payment_configuration`, `gateway`, `gateway_order_id`, `pg_transaction_id`. Receipts/admin show `paymentReference()` (Razorpay pay id or pg transaction id).
- Payments never move a booking backwards: only `Pending` → `Confirmed`. Cancelling a booking with `amount_paid > 0` sets `refund_required` (model level) and chat cancel alerts the admin.

## Admin dashboard

- Accounts: `npm run admin:create`. Passwords scrypt-hashed (min 10 chars). Sessions: random 64-hex cookie `admin_session` (HttpOnly, SameSite=Strict, Path=/admin, Secure behind HTTPS proxy via `trust proxy loopback`), only sha256 stored, 12h expiry, purged daily. CSRF token per session on every POST. Login throttle 5 failures / 15 min per IP+email **and** `ADMIN_LOGIN_MAX_IP_FAILURES` (20) per IP across all emails (in memory, per instance); unknown emails verified against a dummy hash.
- **Business always from the session** (`req.admin.business_id`), never from form input. `requireBusinessAdmin` blocks super admins from writes.
- Pages: Bookings (booking status and payment status columns separate, Razorpay order/payment ids, "Cash received" button), Payment Settings (live preview for ₹500).

## Booking intake API (`POST /api/bookings`)

Body `{ clientName, clientPhone, serviceType, scheduledTime, pickupAddress?, businessId?, externalId? }` (or `Idempotency-Key` header).
Validate → 400 · business from body or `DEFAULT_BUSINESS_ID` · idempotent with key: same details → 200 `duplicate: true` (no second alert), different → 409 · new → 201 + `alertAdminNewBooking` (failure reported, not thrown).

## AI + self-learning (`aiService.js`)

- `detectIntent` → `book | status | cancel | reschedule | confirm | question | greeting | other` (temperature 0, JSON). Keyword fallback order: cancel, reschedule, confirm, greeting (< 25 chars), status, book, question.
- `generateReply` = rules + `businessKnowledge` + similar past Q&A + last 10 messages → `{ reply, needsHuman }`; failures → fallback + `needsHuman`.
- **Learning** (`findSimilarPastAnswers`): past inbound `question` messages paired with the next outbound reply ≤ 10 min whose intent is `question`/`greeting` **and that staff approved** (`messages.approved_at`, admin page **AI Answers**; `AI_LEARNING_REQUIRE_APPROVAL=false` restores automatic learning). Stops one customer teaching the bot wrong facts (fake prices) that are then repeated to others. Menus (`menu`), flow messages (`booking_flow`), `status_update`, `handoff` are never learned.

## Database (`src/models/schema.sql`)

- `businesses(id, name, whatsapp_number unique, created_at)`
- `bookings(id, business_id, client_phone, client_name, service_type, status default 'Pending', pickup_address, scheduled_time, external_id, notes, source 'api'|'whatsapp', latitude DECIMAL(9,6), longitude DECIMAL(9,6), distance_km DECIMAL(7,2), booking_state default 'pending' ('awaiting_location'|'confirmed'|'rejected'), location_precision ('exact'|'approximate'), location_link, created_at, updated_at)` — pg returns DECIMAL as strings; `UNIQUE (business_id, external_id)`
- `messages(id, booking_id?, business_id?, client_phone, direction, content, intent, approved_at?, approved_by? → admin_users, created_at)` — intents: AI intents + `handoff`, `menu`, `booking_flow`, `status_update`, `unsupported`; taps logged as `[tap] Title`, locations `[location] lat,long`, templates `[template:name]`
- `webhook_events(wa_message_id PK, status, attempts, last_error, created_at, updated_at)`
- `conversation_sessions(client_phone PK, flow, step, data jsonb, updated_at)`
- bookings payment columns: `quantity, unit, unit_price, total_amount, currency, payment_status (default not_required), payment_method (razorpay|cod), payment_mode (full|advance), payment_terms jsonb, amount_due_now, amount_paid, amount_remaining, payment_token UNIQUE, refund_required`
- `business_payment_settings(business_id PK/FK, payment_enabled, payment_mode, advance_type, advance_value, allow_cash_on_delivery, online_provider razorpay_link|whatsapp_pay, whatsapp_pay_configuration, whatsapp_pay_gateway, currency, updated_by, …)` with CHECKs
- `payments(id, booking_id FK RESTRICT, business_id FK, provider razorpay|cash, razorpay_order_id UNIQUE, razorpay_payment_id UNIQUE, amount, amount_paise, currency, payment_type full|advance|balance, status created|paid|failed|refunded|partially_refunded, failure_reason, paid_at, refund_status, refunded_amount, razorpay_refund_id, …)`
- `razorpay_webhook_events(event_id PK, event, received_at)`; `admin_users(id, business_id, email unique lower, password_hash, role admin|super_admin)`; `admin_sessions(token_hash PK, admin_id, csrf_token, expires_at)`
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
| `GEOCODER_BASE_URL` / `GEOCODER_USER_AGENT` / `GEOCODER_MIN_INTERVAL_MS` | no (Nominatim / app UA / 1100) | Place-link geocoding; tests point the URL at a mock and set interval 0 |
| `DB_POOL_MAX` | no (10) | Pool size |
| `AI_LEARNING_REQUIRE_APPROVAL` | no (true) | `false` = reuse AI answers without staff approval |
| `ADMIN_LOGIN_MAX_IP_FAILURES` | no (20) | Failed admin logins per IP (any email) per 15 min before blocking |
| `DB_LOCK_POOL_MAX` / `DB_LOCK_TIMEOUT` | no (5 / `60s`) | Connections holding per-customer webhook locks (customers processed in parallel per instance) / max wait for a lock |
| `TRUST_PROXY` | no (`loopback`) | Proxies trusted for `X-Forwarded-For/-Proto` (`req.ip` throttling, `Secure` cookie). Hosted behind a platform proxy (Render): hop count, e.g. `1`. Never `true` (spoofable IP) |
| `LOCAL_DB_PORT` | no (5433) | `db:local` port |
| `WHATSAPP_API_BASE_URL` | no | Graph API host override — tests only |
| `TEST_DATABASE_URL` | no | `npm test` external DB (name must contain "test") |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | no (online payment off) | Razorpay API keys (secret server-only) |
| `RAZORPAY_WEBHOOK_SECRET` | for webhooks | Secret set in Razorpay Dashboard → Webhooks |
| `PUBLIC_BASE_URL` | for online payment | Public HTTPS base for `/pay/<token>` links (ngrok URL locally) |
| `RAZORPAY_API_BASE_URL` | no | Razorpay API override — tests only (mock) |
| `WHATSAPP_PAY_EXPIRY_HOURS` | no (24) | WhatsApp Pay request expiry |
| `WHATSAPP_PAY_SYNC_MINUTES` | no (5) | Interval for reconciling unpaid WhatsApp Pay requests |

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
- Gaps: sessions keyed by phone only (single tenant); admin notifications are text (24h rule); retrying a failed webhook event can resend a reply; `BOOKING_API_KEY` is one key for all businesses (any holder can create/update bookings of any business — per-business API keys needed before multi-tenant); AI answers/learning not scoped per business; AI tests use a mock model; `embedded-postgres` pinned to `18.4.0-beta.17`.
