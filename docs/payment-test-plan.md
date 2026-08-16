# Payment & Refund Test Plan (local Supabase + emulator)

> **Coming from the 2026-08-10 fix pass:** read/run the sections below in
> order — the earlier scenarios in this file still apply, but the refund
> math changed (fee kept on self-cancel) and there are new surfaces to test
> (Refunds tab, QR ticket, refund notifications, per-event statement filter).

## THIS FIX PASS — Pass 1 + Pass 2 (2026-08-10)

Files changed (all local, **nothing pushed**):

```
supabase/functions/reconcile-payments/index.ts      # clawback + real status + duplicate-receipt re-verify
supabase/functions/verify-payment-webhook/index.ts  # clawback fail-soft + refund notifications + real status
supabase/functions/cancel-registration/index.ts     # receipt + FEE-KEEP policy + preview + notification
supabase/functions/cancel-event/index.ts            # receipt + state-first ordering + event attribution
supabase/functions/issue-refund/index.ts            # NEW: organizer-initiated refund
supabase/functions/get-wallet-statement/index.ts    # optional event_id filter
supabase/migrations/202608100004_wallet_event_attribution.sql   # p_event_id, statement, audit_log_team_read
supabase/migrations/202608100005_payments_realtime.sql          # payments into realtime publication
apps/organizer-web/src/components/payout/payout-section.tsx     # type filters + refund rows highlight
apps/organizer-web/src/components/payout/refunds-section.tsx    # NEW: Refunds tab + issue-refund modal
apps/organizer-web/src/pages/dashboard.tsx                      # Refunds nav item
apps/organizer-web/src/components/events/event-form.tsx         # live per-ticket split preview
apps/organizer-web/src/components/events/event-detail.tsx       # amount column + cancel result alert
apps/mobile/lib/screens/payment_detail_screen.dart  # realtime + notifications timeline + refund labels
apps/mobile/lib/screens/my_payments_screen.dart     # human refund chips
apps/mobile/lib/screens/my_registrations_screen.dart# refund notices + ticket entry
apps/mobile/lib/screens/ticket_screen.dart          # NEW: QR ticket
apps/mobile/lib/screens/event_detail_screen.dart    # checkout disclosure + cancel preview dialog
apps/mobile/lib/app.dart + pubspec.yaml             # /ticket/:id route + qr_flutter dep
apps/mobile/lib/providers/activity_provider.dart    # amount/refunded_amount in payments embed
```

### Preflight (local-only)

```bash
supabase start                # Docker must be running
supabase db push              # applies 202608100004 + 202608100005
supabase functions serve      # .env.local keeps TEST keys
cd apps/mobile && flutter pub get && flutter run
cd apps/organizer-web && npm run dev
```

Static checks already passing (rerun anytime):

```bash
npx deno check --node-modules-dir=auto supabase/functions/<fn>/index.ts   # all 9
cd apps/mobile && flutter analyze                                          # 0 errors
npx tsc --noEmit -p apps/organizer-web                                     # only pre-existing shared/use-profile errors
```

### A. Wallet event attribution (migration test)

```bash
BASE=http://127.0.0.1:54321
TOKEN=<your user session token>
# per-event statement
curl "$BASE/functions/v1/get-wallet-statement?community_id=<cid>&event_id=<eid>" -H "Authorization: Bearer $TOKEN"
```
Expect: rows carry `event_id`; a `Refund: ...` entry (wallet_debited) now
appears per refund with the right sign; withdrawals excluded when filtering
by event. Full statement still ends at the exact wallet balance shown on the
Payout page.

### B. Self-cancel FEE-KEEP rule

1. Register + pay ₹1000 (test card) for an event starting in >24h.
2. Cancel from the event page → preview dialog shows
   **Refund ₹900 · booking fee ₹100 not refundable**.
3. DB after cancel:
   - `payments`: status `refunded`, `refund_status` pending/queued/processed,
     `razorpay_refund_id` set, `refunded_amount = 90000`.
   - `payment_audit_log` has `refund_issued` (amount 90000),
     `platform_fee_kept` (fee_amount 10000), `wallet_debited` with
     `details.event_id` set.
   - NO `commission_reversed` row.
   - Razorpay dashboard (test): refund of ₹900, receipt `ref_<payment_id>`.
4. Notifications: `refund_initiated` for the customer with the fee-kept copy.

### C. Organizer-cancel full refund (regression + receipts)

1. Organizer cancels an event with 2 paid registrations + 1 free one.
2. Expect: 2 Razorpay refunds of ₹1000 & ₹900 **receipt `ref_<payment_id>`**;
   `commission_reversed` x2 with `commission_amount`; `wallet_debited` x2
   (organizer share only); free registration cancelled, no refund.
3. EventDetail now shows the amount column; the browser alert reports
   `2 refund(s) initiated`.

### D. Reconcile clawback + status truth + duplicate-receipt re-verify

1. Manually create a stuck state: `payments.status='refunded'`,
   `refund_status='requested'`, `refund_attempt_count=0` for a captured
   payment → run reconcile (cron or `curl baseUrl/... ` invoke). Expect it to
   refund with receipt `ref_<id>`, `refund_status` = Razorpay's real value
   (not a hardcoded "processed"), and a `wallet_debited` clawback row.
2. Burned-receipt retry: trigger a refund so the first attempt fails server-
   side (e.g., temporarily wrong key), then restore the key and re-run.
   Expect `refund_issued` with **retried_receipt: true** and receipt
   `ref_<id>_2`.
3. Double-refund guard: repeat the same reconcile run twice. Second run must
   NOT create a refund without `payment_id` in wallet rows.
4. `refund_wallet_debit_failed` shows up in audit if the wallet debit ever
   fails while the Razorpay refund succeeded (simulate by making
   `debit_wallet` fail: delete the community row).

### E. Webhook capacity-full path (regression with fail-soft clawback)

- Fill an event so `confirm_payment` returns `refund_required`, then send the
  captured webhook (helpers at the bottom of this file). Expect: full refund
  WITH receipt, `commission_reversed`, `refund_initiated` notification, and
  `refund_status` mapped from the entity (not hardcoded).

### F. Issue-refund (new function + Refunds tab)

1. Organizer-web → **Refunds** nav → list shows refunded payments with
   attendee, event, amount, status chip.
2. Click **Issue Refund** → pick an attendee with a successful payment →
   confirm. Expect full refund (fee included), `commission_reversed`,
   wallet clawback, `refund_initiated` notification.
3. Authorization: a non-owner/moderator member gets 403.
4. Re-click the same payment → 409 "Refund already ..." once it settles.

### G. Real-time + notifications

1. Payment detail: while it's open, complete a refund server-side (via
   webhook curl) → status chip and Activity timeline update **without
   refresh** (needs 202608100005 deployed).
2. My Payments: refund chip shows "Refunded", "Refund Processing", etc. —
   no raw `refund_status` strings.
3. My Registrations: cancelled + refunded shows `Cancelled · refunded ₹900`.

### H. QR ticket

1. After a successful paid registration, My Registrations shows a **Ticket**
   chip; tap → `/ticket/:id` screen with the QR code, event, date, ticket id.
2. Free registrations also get a ticket (qr_code is set on confirm).

### I. Refund policy copy (mobile)

1. Event page for a paid event shows the disclosure under the Pay button,
   **calculated from the community's real commission_percent**.
2. Cancel flow shows the exact refund amount in the preview dialog.

## Earlier scenarios (still valid — see the updated refund math above)

Run everything against **local Supabase** with **Razorpay test keys**
(`rzp_test_...` / `key_..._test`). Never point a local run at production keys.

## Setup

```bash
# 1. Start local Supabase (Postgres + Edge runtime)
supabase start

# 2. Apply the refund-policy migration (widened refund_status check,
#    refund_attempt_count, confirm_payment cancelled-event guard)
supabase db push

# 3. Load function env (test keys) and serve edge functions
#    .env.local needs: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET (all _test)
supabase functions serve

# 4. Point the app at local Supabase (apps/mobile) and run it
cd apps/mobile && flutter run
```

Local base URL for curl: `http://127.0.0.1:54321`

```bash
BASE=http://127.0.0.1:54321
ANON=<your local anon key>                       # supabase start output
SECRET=<RAZORPAY_WEBHOOK_SECRET>                 # test secret
EMAIL=<your test user email>
PASS=<your test user password>
```

## Helper: sign a webhook payload like Razorpay

```bash
# sign.sh  (payload file, secret) -> signature
sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$2" -hex | awk '{print $2}'; }
```

---

## 1. Happy path — paid registration

```bash
# Pick a published, paid event (price > 0)
curl -s "$BASE/rest/v1/events?select=id,title,price,status&status=eq.published&price=gt.0" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"

# Login and create the payment order from the app OR directly:
BODY='{"event_id":"<EVENT_ID>"}'
curl -s -X POST "$BASE/functions/v1/create-payment" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "Content-Type: application/json" -d "$BODY"
# -> expect { registration_id, razorpay_order_id, amount }
```

In the app: event detail -> **Pay** -> Razorpay test checkout -> card
`4111 1111 1111 1111`, any future expiry, any CVV -> success.

**Expected:** webhook `payment.captured` confirms the booking; payment row
`status=success`; registration `status=confirmed` + QR code; community wallet
credited `organizer_share`; audit `payment_confirmed`.

## 2. Webhook signature + replay protection

```bash
# Build a payment.captured payload (created_at must be < 5 min old)
cat > /tmp/wh.json <<'EOF'
{
  "created_at": 1750000000,
  "event": "payment.captured",
  "payload": { "payment": { "entity": { "id": "pay_test_1", "order_id": "<ORDER_ID>", "amount": 10000 } } }
}
EOF
# Fix created_at to now, then:
SIG=$(sign "$(cat /tmp/wh.json)" "$SECRET")
curl -s -X POST "$BASE/functions/v1/verify-payment-webhook" \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: $SIG" \
  -H "x-razorpay-event-id: evt_test_1" \
  --data-binary @/tmp/wh.json

# Replay the SAME event id -> expect "Already processed"
# Tamper with the payload (no signature) -> expect 401
# Set created_at to 10 min ago -> expect 400 "Webhook too old"
```

**Expected:** only the HMAC-verified, deduped, fresh webhook confirms the payment.

## 3. Pay-during-cancel race (refund_required)

1. Create a payment order for a **published** event (do NOT simulate success yet).
2. Cancel the event (as organizer): `cancel-event`.
3. Now deliver the `payment.captured` webhook (step 2 payload).

**Expected:** `confirm_payment` sees `status='cancelled'` -> payment marked
`failed`, response `refund_required`; webhook calls `processRefund`:
payment `status=refunded`, `refund_status=processed`, `razorpay_refund_id`
stored, wallet debited back, audit `refund_issued`. Customer refunded the
FULL amount (incl. platform fee, `commission_reversed` audit).

## 4. Path C — paid order lost its callback

1. Create a payment order, then simulate the customer paying **manually on
   Razorpay dashboard/test** (capture the payment against that order).
2. Keep the DB payment row `pending` (make the webhook "fail" by not sending it).
3. In the app, hit cleanup-booking on retry (or call the function).

```bash
BODY='{"event_id":"<EVENT_ID>"}'
curl -s -X POST "$BASE/functions/v1/cleanup-booking" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "Content-Type: application/json" -d "$BODY"
```

**Expected:** Razorpay order check says `paid` -> `confirm_payment` runs ->
booking **confirmed** (not cancelled), audit `booking_reconciled`. Repeat from
`create-payment` (order-reuse branch): returns `exists: true,
payment_status: confirmed`.

If the event was cancelled meanwhile: returns `reconciled: refund_required`
and the money is returned via the retry job (step 6).

## 5. Refund webhook sync

For each refund state Razorpay sends, POST the matching webhook and check the row:

```bash
cat > /tmp/refund.json <<'EOF'
{
  "created_at": 1750000000,
  "event": "refund.created",
  "payload": { "refund": { "entity": { "id": "rfnd_test_1", "payment_id": "<PAY_ID>", "status": "created", "amount": 10000 } } }
}
EOF
SIG=$(sign "$(cat /tmp/refund.json)" "$SECRET")
curl -s -X POST "$BASE/functions/v1/verify-payment-webhook" \
  -H "Content-Type: application/json" -H "x-razorpay-signature: $SIG" \
  -H "x-razorpay-event-id: evt_refund_1" --data-binary @/tmp/refund.json

# then refund.processed -> refund_status=processed, status=refunded, refunded_amount
# then refund.failed    -> refund_status=failed, refund_attempt_count +1
```

**Expected:** `payments.refund_status` + `refund_attempt_count` + audit
`refund_status_synced` always match Razorpay's truth.

## 6. Retry job + 5-attempt cap

Run the cron manually:

```bash
curl -s "$BASE/functions/v1/reconcile-payments" -H "apikey: $ANON" \
  -H "Authorization: Bearer $ANON"
```

Force a refund failure (bad razorpay_payment_id or duplicated receipt) and
re-run until `refund_attempt_count` reaches 5.

**Expected:** each run retries (up to 5, with the 15-min cooldown), then the
payment stays `failed` + audit `refund_retry_exhausted` flags manual follow-up.
A duplicate-receipt error marks the payment `refunded` instead of double-refunding.

## 8. No-refresh behavior

- **Time-driven (60s tick, no network):** keep an event detail screen open
  across `start_date` -> the button flips to the red **Live** chip; hold it
  across `end_date` -> it flips to **Event Closed**. Same for cards: open the
  events page past a start time and chips re-render within a minute.
- **Events page list pruning:** an event that turns closed while the page is
  open gets dropped from the list within ~a minute (one refetch).
- **Realtime (2s debounce):** open the events page, then cancel the event from
  the organizer web -> card disappears/changes without touching the phone.
  Open an active event detail, pay from another device (webhook confirms) ->
  the **Registered** chip appears without refresh. In the community events
  tab, create/publish an event for that community elsewhere -> it appears and
  sorts into place automatically.
- Requires the realtime migration pushed: `202608100002_events_registrations_realtime.sql`.

## 7. Event lifecycle + regressions (everything must still work)

Event state is date-derived: **active** (now < start) accepts registration/payment,
**live** (now inside start..end) shows only a live indicator, **closed**
(now past end; events without an end_date stay live until their DB status
changes) blocks everything.

- Free event while **active**: **Register** works end to end.
- Paid event while **active**: **Pay ₹<amount>** button (amount shown), Razorpay
  checkout flows, webhook confirms.
- Event while **live**: button area shows only the red **Live** chip with icon —
  no pay/register for anyone, even registered users.
- Event after end (**closed**): "Event Closed" box, no buttons, for paid and free.
- Cancelled event: red "Event Cancelled" box.
- Events page (mobile): only **live + active** events shown; closed drop off.
- Community events tab: all community events, order = **live -> active ->
  closed -> cancelled**, newest start date first; cards show a status chip
  (Live/Active/Closed/Cancelled) ABOVE the price or "Free" label.
- Server gates (all payment paths active-only): `create-payment`,
  `create-payment-order` (new), `register-for-event` reject once the event
  starts ("Event has already started") or when cancelled/completed/unpublished.
- Self-cancel within the 24h window: **fee kept** (`platform_fee_kept` audit),
  organizer share only returned to the customer, wallet clawback debits the
  organizer share (NOT the fee).
- Self-cancel after the 24h window: blocked (`cancellation_closed`).
- Organizer cancels event: every confirmed registration refunded **in full
  (fee included)**, `commission_reversed` audit, wallet clawback of the
  organizer share only.

## CI check

```bash
cd apps/mobile && flutter analyze
```