# Master Workflow Map: Cluvo Platform (Stage 7 Audit)

This document maps all core end-to-end workflows of the Cluvo platform, tracing execution from the frontend user interface, through service layers and Edge Functions, to PostgreSQL database operations and external third-party integrations.

---

## Complete End-to-End Workflow Tracing

```
[User Interface] ──▶ [Service / Hook] ──▶ [Edge Function / RPC] ──▶ [PostgreSQL Engine] ──▶ [External Provider]
       │                       │                     │                         │                      │
       ▼                       ▼                     ▼                         ▼                      ▼
  User Input            JWT & Validation       Business Logic            Atomic ACID Tx         Razorpay / Cloudinary
```

---

### Workflow 1: Customer Registration and Login
- **Entry Point**: Mobile App Login screen (`/login` or `/signup`).
- **Frontend Files**: [apps/mobile/lib/screens/login_screen.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/screens/login_screen.dart), [apps/mobile/lib/providers/auth_provider.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/providers/auth_provider.dart).
- **Backend Functions**: Supabase GoTrue Auth API (`signInWithPassword`, `signUp`, `signInWithOAuth`), Edge Function `complete-google-profile`.
- **Database Tables**: `auth.users`, `public.profiles`.
- **External Integrations**: Google OAuth Identity Provider.
- **Authorization Checks**: Anonymous callers permitted. Email confirmation and password complexity enforced. Blocked users flagged in `profiles.is_banned` rejected.
- **Error Handling**: Invalid credentials return friendly error; banned users receive account notice; rate limiting kicks in after 5 failed attempts.
- **Final State**: Authenticated session established; `AuthState` holds JWT access token; user routed to `/consent` gate or `/home`.
- **Existing Tests**: `apps/mobile/test/login_consent_test.dart`.
- **Missing Tests**: Refresh token expiry during active checkout flow; network timeout during Google OAuth profile completion.

---

### Workflow 2: Community Creation and Approval Flow
- **Entry Point**: Organizer Web Dashboard (`/dashboard`) for new users without a community.
- **Frontend Files**: [apps/organizer-web/src/components/community-details-form.tsx](file:///Users/shivapraneeth/Documents/community/apps/organizer-web/src/components/community-details-form.tsx), [apps/organizer-web/src/components/waiting-for-approval.tsx](file:///Users/shivapraneeth/Documents/community/apps/organizer-web/src/components/waiting-for-approval.tsx).
- **Backend Functions**: Edge Function `create-community`, RPC `approve_community_application`, RPC `reject_community_application`, Edge Function `notify-community-approval`.
- **Database Tables**: `public.community_applications`, `public.communities`, `public.community_members`, `public.profiles`.
- **External Integrations**: None.
- **Authorization Checks**: Authenticated user; user must not already own an active community (`one_community_per_owner`); approval/rejection restricted to `is_admin_user()`.
- **Error Handling**: Duplicate community name or slug rejected; validation errors surfaced on step 1 & 2; rejection displays reviewer feedback.
- **Final State**: Application created in `pending` status. On admin approval, `communities` row inserted, organizer assigned `owner` role in `community_members`, and organizer gains dashboard access.
- **Existing Tests**: `supabase/tests/community_applications_and_approval_flow.test.ts`.
- **Missing Tests**: Concurrent submission of applications with identical names; organizer session handling when admin rejects while organizer is viewing waiting screen.

---

### Workflow 3: Joining and Leaving Communities
- **Entry Point**: Mobile App Community Detail screen (`/communities/:id`).
- **Frontend Files**: [apps/mobile/lib/widgets/communities/community_join_button.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/widgets/communities/community_join_button.dart), [apps/mobile/lib/screens/community_detail_screen.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/screens/community_detail_screen.dart).
- **Backend Functions**: Direct PostgreSQL insert/delete on `community_members` gated by RLS and triggers.
- **Database Tables**: `public.community_members`, `public.communities`.
- **External Integrations**: None.
- **Authorization Checks**: Authenticated attendee (`auth.uid() = user_id`); community must be public and accepting members (`is_community_accepting_members(community_id) = true`). Cannot join a community in closure grace.
- **Error Handling**: Database exception if community is closed or in deletion grace; optimistic UI rolls back on network failure.
- **Final State**: Row added/removed in `community_members`; trigger `update_community_member_count()` updates `communities.member_count`.
- **Existing Tests**: `supabase/tests/community_closure_guard.test.ts`, `apps/mobile/test/community_detail_repro_test.dart`.
- **Missing Tests**: Concurrent join/leave requests from the same user across multiple mobile devices.

---

### Workflow 4: Event Creation and Publishing
- **Entry Point**: Organizer Web Events tab $\to$ "Create Event" (`/dashboard#events`).
- **Frontend Files**: [apps/organizer-web/src/components/events/event-form.tsx](file:///Users/shivapraneeth/Documents/community/apps/organizer-web/src/components/events/event-form.tsx), [apps/organizer-web/src/hooks/use-events.ts](file:///Users/shivapraneeth/Documents/community/apps/organizer-web/src/hooks/use-events.ts).
- **Backend Functions**: Direct Supabase insert into `events` table with RLS enforcement.
- **Database Tables**: `public.events`, `public.communities`.
- **External Integrations**: OpenStreetMap / Nominatim (location geocoding), Cloudinary (event banner upload).
- **Authorization Checks**: Caller must be community owner or moderator (`is_community_owner(community_id)`). Start date must be at least 1 hour in the future (`events_start_date_validation`).
- **Error Handling**: Geocoding fallback to manual address input; past date rejected by database constraint; image upload size verified $\le 15$MB.
- **Final State**: Event row created with `status = 'published'` (or `'draft'`); `booked_count = 0`; appears in discovery feeds.
- **Existing Tests**: `apps/organizer-web/src/components/events/event-form.test.tsx`.
- **Missing Tests**: Validation when end date is earlier than start date; behavior when Nominatim geocoding service times out.

---

### Workflow 5: Event Discovery, Search, and Geolocation Filtering
- **Entry Point**: Mobile App Home (`/home`), Events (`/events`), and Search (`/search`).
- **Frontend Files**: [apps/mobile/lib/screens/home_screen.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/screens/home_screen.dart), [apps/mobile/lib/screens/search_screen.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/screens/search_screen.dart), [apps/mobile/lib/services/location_service.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/services/location_service.dart).
- **Backend Functions**: RPC `events_with_distance`, PostgreSQL text search queries with RLS.
- **Database Tables**: `public.events`, `public.communities`.
- **External Integrations**: Device GPS, OpenStreetMap reverse geocoding.
- **Authorization Checks**: Public read permitted for published, non-deleted, non-hidden events from active communities.
- **Error Handling**: Location service permission denied falls back to city selector; empty search results render styled empty state.
- **Final State**: Event feed populated with matching events ordered by distance, date, or popularity.
- **Existing Tests**: `apps/mobile/test/home_widgets_test.dart`, `apps/mobile/test/search_widgets_test.dart`, `apps/mobile/test/location_matching_test.dart`.
- **Missing Tests**: Pagination boundary test when search returns $> 100$ items; behavior when device GPS coordinates are null.

---

### Workflow 6: Free Event Booking
- **Entry Point**: Mobile App Event Detail screen (`/events/:id`) $\to$ "Register for Free".
- **Frontend Files**: [apps/mobile/lib/screens/event_detail_screen.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/screens/event_detail_screen.dart).
- **Backend Functions**: Edge Function `register-for-event`, PostgreSQL RPC `register_free_event`.
- **Database Tables**: `public.events`, `public.registrations`.
- **External Integrations**: None.
- **Authorization Checks**: Authenticated user; user must have active legal consent; event must be price $= 0$, `status = 'published'`, and `booked_count < capacity`.
- **Error Handling**: Capacity full returns 409 Conflict; event started returns 410 Gone; double booking returns existing registration.
- **Final State**: Registration inserted with `status = 'confirmed'`; `events.booked_count` incremented by 1; ticket pass available in `/ticket/:id`.
- **Existing Tests**: `supabase/tests/atomic_free_registration.test.ts`.
- **Missing Tests**: Concurrent free registration requests for the exact last available ticket.

---

### Workflow 7: Paid Event Booking and Order Creation
- **Entry Point**: Mobile App Event Detail screen (`/events/:id`) $\to$ "Book Ticket".
- **Frontend Files**: [apps/mobile/lib/screens/event_detail_screen.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/screens/event_detail_screen.dart).
- **Backend Functions**: Edge Function `create-payment`, PostgreSQL RPC `reserve_ticket_capacity`.
- **Database Tables**: `public.events`, `public.registrations`, `public.payments`.
- **External Integrations**: Razorpay Orders API (`POST https://api.razorpay.com/v1/orders`).
- **Authorization Checks**: Authenticated attendee; attendee accepts 24h cancellation policy sheet; event capacity holds evaluated.
- **Error Handling**: `capacity_held` returns 409; `already_paid` routes to verification; network failure rolls back booking hold.
- **Final State**: Registration created in `status = 'pending'`; payment created in `status = 'pending'` with 10-minute `booking_hold_expires_at`; Razorpay `order_id` returned to client.
- **Existing Tests**: `test/paid_event_button_test.dart`, `supabase/tests/incoming_payment_concurrency.test.ts`.
- **Missing Tests**: Re-quoting behavior when customer opens checkout dialog, abandons for 9 minutes, and re-clicks book.

---

### Workflow 8: Razorpay Payment Execution and Signature Verification
- **Entry Point**: Mobile / Web Razorpay Checkout modal.
- **Frontend Files**: [apps/mobile/lib/screens/event_detail_screen.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/screens/event_detail_screen.dart), [apps/mobile/lib/services/razorpay_web.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/services/razorpay_web.dart).
- **Backend Functions**: Edge Function `verify-payment`, Edge Function `verify-payment-webhook`, PostgreSQL RPC `confirm_payment`.
- **Database Tables**: `public.payments`, `public.registrations`, `public.processed_webhooks`, `public.communities`.
- **External Integrations**: Razorpay Checkout SDK, Razorpay Webhook delivery.
- **Authorization Checks**: Razorpay HMAC-SHA256 signature verification matching `order_id|payment_id` against `RAZORPAY_KEY_SECRET`.
- **Error Handling**: Payment failure or cancellation invokes `cleanup-booking`; signature mismatch rejects with 400 Bad Request.
- **Final State**: Payment marked `status = 'success'`; registration updated to `status = 'confirmed'`; community `wallet_balance` credited; 256-bit CSPRNG QR ticket token generated.
- **Existing Tests**: `tests/stage6_db_concurrency_test.cjs`, `supabase/tests/incoming_payment_concurrency.test.ts`.
- **Missing Tests**: Simultaneous arrival of client-side `verify-payment` call and server-side Razorpay webhook within 10ms.

---

### Workflow 9: Cryptographic Ticket Generation and Pass Display
- **Entry Point**: Triggered by payment confirmation; viewed at `/ticket/:id`.
- **Frontend Files**: [apps/mobile/lib/screens/ticket_screen.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/screens/ticket_screen.dart), [apps/mobile/lib/widgets/ticket_card.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/widgets/ticket_card.dart).
- **Backend Functions**: PostgreSQL RPC `confirm_payment` (`202611010016`).
- **Database Tables**: `public.registrations`.
- **External Integrations**: None.
- **Authorization Checks**: Attendee can only view own ticket (`auth.uid() = user_id`) unless organizer/admin.
- **Error Handling**: Cancelled registrations display "Cancelled" banner; missing ticket redirects to `/events`.
- **Final State**: Ticket renders event details, seat/ticket count, and dynamic QR code generated from 64-character SHA-256 hash.
- **Existing Tests**: `tests/stage6_db_concurrency_test.cjs` (Section 6), `test/widget_test.dart`.
- **Missing Tests**: Offline caching of QR code when attendee has no cellular connection at venue entrance.

---

### Workflow 10: Attendee QR Code Check-In
- **Entry Point**: Organizer Web Check-In page (`/dashboard#check-in`) $\to$ Camera Scan or Manual Code Entry.
- **Frontend Files**: [apps/organizer-web/src/pages/check-in-page.tsx](file:///Users/shivapraneeth/Documents/community/apps/organizer-web/src/pages/check-in-page.tsx), [apps/organizer-web/src/components/check-in/scan-modal.tsx](file:///Users/shivapraneeth/Documents/community/apps/organizer-web/src/components/check-in/scan-modal.tsx).
- **Backend Functions**: Edge Function `check-in`, PostgreSQL RPC `check_in_registration`.
- **Database Tables**: `public.registrations`, `public.events`, `public.payment_audit_log`.
- **External Integrations**: None.
- **Authorization Checks**: Caller must be community owner, organizer, or moderator. Ticket must match selected event.
- **Error Handling**: Ticket already scanned returns warning with timestamp; ticket for another event/community rejected with explicit message; cancelled ticket rejected.
- **Final State**: `registrations.checked_in = true`, `checked_in_at = clock_timestamp()`, `status = 'attended'`; audit log recorded; check-in stats card updated live.
- **Existing Tests**: `apps/organizer-web/src/components/check-in/check-in.test.tsx`, `tests/stage6_db_concurrency_test.cjs` (Section 2).
- **Missing Tests**: Concurrent scan of the same QR code by two gate volunteers simultaneously.

---

### Workflow 11: Customer Self-Cancellation and Refund Processing
- **Entry Point**: Mobile App Event Detail screen (`/events/:id`) $\to$ "Cancel Registration".
- **Frontend Files**: [apps/mobile/lib/screens/event_detail_screen.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/screens/event_detail_screen.dart) (lines 831–930).
- **Backend Functions**: Edge Function `cancel-registration`, RPC `cancel_registration_and_decrement`, `attemptRefund` (`_shared/refunds.ts`).
- **Database Tables**: `public.registrations`, `public.payments`, `public.events`, `public.payment_audit_log`, `public.notifications`.
- **External Integrations**: Razorpay Refunds API (`POST https://api.razorpay.com/v1/payments/:id/refunds`).
- **Authorization Checks**: Attendee must own registration; cancellation must be $\ge 24$ hours before event start (`cancellation_closed`); ticket must NOT be attended (`checked_in = false`).
- **Error Handling**: Policy deadline rejection; Razorpay refund failure flags claim as `failed` for automated reconcile retry; platform fee retained by policy.
- **Final State**: Registration cancelled; QR code cleared; `events.booked_count` decremented; payment updated to `status = 'refunded'`; refund notification sent to attendee.
- **Existing Tests**: `supabase/tests/refund_policy_amounts.test.ts`, `apps/mobile/test/refund_detail_navigation_test.dart`.
- **Missing Tests**: End-to-end integration test calling `cancel-registration` with a mocked Razorpay 500 error followed by reconcile retry.

---

### Workflow 12: Event Cancellation and Bulk Asynchronous Refund Queue
- **Entry Point**: Organizer Web Event Detail $\to$ "Cancel Event" (`/dashboard#events`).
- **Frontend Files**: [apps/organizer-web/src/components/events/cancel-event-confirm-dialog.tsx](file:///Users/shivapraneeth/Documents/community/apps/organizer-web/src/components/events/cancel-event-confirm-dialog.tsx), `cancellation-progress-modal.tsx`.
- **Backend Functions**: Edge Function `cancel-event`, PostgreSQL RPC `cancel_event_and_enqueue_refunds`, Edge Function `process-cancellation-queue`.
- **Database Tables**: `public.events`, `public.event_cancellation_jobs`, `public.refund_task_queue`, `public.payments`, `public.registrations`.
- **External Integrations**: Razorpay Refunds API.
- **Authorization Checks**: Caller must be community owner or platform admin. Cannot cancel an event that has already started or completed.
- **Error Handling**: Tasks that encounter transient provider errors are retried with exponential backoff; uncertain outcomes locked for admin review.
- **Final State**: Event status updated to `'cancelled'`; cancellation job created; queue worker processes batches of 20 tasks; attendees receive 100% refund (including fee).
- **Existing Tests**: `apps/organizer-web/src/components/events/cancel-event.test.tsx`, `supabase/tests/cancellation_queue.test.ts`.
- **Missing Tests**: Worker lease expiration and task stealing when a worker dies mid-batch.

---

### Workflow 13: Organizer Financial Statement and Earnings Calculation
- **Entry Point**: Organizer Web Payout tab (`/dashboard#payout`).
- **Frontend Files**: [apps/organizer-web/src/components/payout/payout-section.tsx](file:///Users/shivapraneeth/Documents/community/apps/organizer-web/src/components/payout/payout-section.tsx).
- **Backend Functions**: PostgreSQL RPC `get_organizer_financial_statement`.
- **Database Tables**: `public.communities`, `public.events`, `public.payments`, `public.payout_items`.
- **External Integrations**: None.
- **Authorization Checks**: Caller must be community owner or team member with financial read privileges.
- **Error Handling**: Empty statement renders zeroed breakdown; non-owner access blocked by database security definer check.
- **Final State**: Passbook ledger loaded with gross sales, platform fee deductions, verified refunds, settled payouts, and remaining uncommitted balance in integer paise.
- **Existing Tests**: `apps/organizer-web/src/components/payout/payout-section.test.tsx`, `tests/stage6_manual_settlement_test.cjs`.
- **Missing Tests**: Multi-event balance calculation when an event has negative net due to refunds exceeding sales.

---

### Workflow 14: Admin Manual Settlement Recording (Offline Bank Transfer)
- **Entry Point**: Admin Web Financials page $\to$ "Record Manual Payout" (`/financials`).
- **Frontend Files**: [apps/admin-web/src/components/ManualPayoutModal.tsx](file:///Users/shivapraneeth/Documents/community/apps/admin-web/src/components/ManualPayoutModal.tsx).
- **Backend Functions**: PostgreSQL RPC `admin_record_manual_payout`.
- **Database Tables**: `public.payout_items`, `public.communities`, `public.events`, `public.payment_audit_log`.
- **External Integrations**: Admin's external banking/UPI interface (performed outside Cluvo).
- **Authorization Checks**: Caller must be platform admin (`profiles.is_admin = true`). Payout amount must not exceed uncommitted wallet balance or event balance.
- **Error Handling**: Over-allocation rejected with `insufficient_uncommitted_balance`; duplicate active UTR rejected with `duplicate_payout_utr`.
- **Final State**: Payout item inserted with `status = 'pending_confirmation'`; amount reserved; immutable audit log entry written.
- **Existing Tests**: `apps/admin-web/src/components/ManualPayoutModal.test.tsx`, `tests/stage6_manual_settlement_test.cjs` (Tests 5–9).
- **Missing Tests**: Multi-currency input handling (ensuring only INR paise can be submitted).

---

### Workflow 15: Organizer Settlement Confirmation
- **Entry Point**: Organizer Web Payout tab $\to$ Pending Settlement card $\to$ "Confirm Receipt".
- **Frontend Files**: [apps/organizer-web/src/components/payout/payout-section.tsx](file:///Users/shivapraneeth/Documents/community/apps/organizer-web/src/components/payout/payout-section.tsx).
- **Backend Functions**: PostgreSQL RPC `organizer_confirm_manual_payout`.
- **Database Tables**: `public.payout_items`, `public.communities`, `public.payment_audit_log`.
- **External Integrations**: None.
- **Authorization Checks**: Caller must be community owner (`communities.owner_id = auth.uid()`). Payout must be in `pending_confirmation`.
- **Error Handling**: Concurrency lock prevents double debit; competing confirmation fails with `invalid_payout_status`.
- **Final State**: Payout status updated to `'success'`; `communities.wallet_balance` debited by payout amount; `payment_audit_log` records `wallet_debited`.
- **Existing Tests**: `apps/organizer-web/src/components/payout/payout-section.test.tsx`, `tests/stage6_manual_settlement_test.cjs` (Tests 1–4).
- **Missing Tests**: UI behavior when network drops between RPC execution and client response reception.

---

### Workflow 16: Organizer Settlement Dispute Filing
- **Entry Point**: Organizer Web Payout tab $\to$ Pending Settlement card $\to$ "Dispute".
- **Frontend Files**: [apps/organizer-web/src/components/payout/payout-section.tsx](file:///Users/shivapraneeth/Documents/community/apps/organizer-web/src/components/payout/payout-section.tsx).
- **Backend Functions**: PostgreSQL RPC `organizer_dispute_manual_payout`.
- **Database Tables**: `public.payout_items`, `public.admin_alerts`, `public.payment_audit_log`.
- **External Integrations**: None.
- **Authorization Checks**: Caller must be community owner. Dispute reason must be non-empty. Payout must be in `pending_confirmation`.
- **Error Handling**: Rejects dispute if payout was already confirmed by co-organizer; dispute notes validated.
- **Final State**: Payout status transitioned to `'disputed'`; reserved balance remains locked; high-priority alert created in `admin_alerts`.
- **Existing Tests**: `apps/organizer-web/src/components/payout/payout-section.test.tsx`, `tests/stage6_manual_settlement_test.cjs` (Test 2).
- **Missing Tests**: Notification dispatch to admin email on dispute creation.

---

### Workflow 17: Admin Dispute Resolution and Settlement Cancellation
- **Entry Point**: Admin Web Financials page $\to$ Disputed / Pending transaction $\to$ "Resolve Dispute" or "Cancel Settlement".
- **Frontend Files**: [apps/admin-web/src/components/PayoutDisputeResolutionModal.tsx](file:///Users/shivapraneeth/Documents/community/apps/admin-web/src/components/PayoutDisputeResolutionModal.tsx).
- **Backend Functions**: PostgreSQL RPC `admin_resolve_payout_dispute`, PostgreSQL RPC `admin_cancel_manual_payout`.
- **Database Tables**: `public.payout_items`, `public.communities`, `public.payment_audit_log`.
- **External Integrations**: None.
- **Authorization Checks**: Platform administrator role required. Resolution requires minimum 10-character audit note.
- **Error Handling**: Mismatched status rejected; invalid resolution action rejected; parameter contract `p_cancel_reason` verified.
- **Final State**: Disputed payout resolved to `'success'` (debits wallet) or `'cancelled'` (releases reservation without debiting wallet); audit trail preserved.
- **Existing Tests**: `apps/admin-web/src/components/PayoutDisputeResolutionModal.test.tsx`, `tests/stage6_manual_settlement_test.cjs` (Tests 3, 11, 12, 15).
- **Missing Tests**: Resolution when community owner deletes community during dispute review.

---

### Workflow 18: 3-Way Financial Reconciliation and Ledger Audit
- **Entry Point**: Admin Web Financials page $\to$ "Reconciliation Audit" button.
- **Frontend Files**: [apps/admin-web/src/pages/FinancialsPage.tsx](file:///Users/shivapraneeth/Documents/community/apps/admin-web/src/pages/FinancialsPage.tsx).
- **Backend Functions**: PostgreSQL RPC `run_financial_reconciliation`, PostgreSQL RPC `get_financial_observability_kpis`.
- **Database Tables**: `public.communities`, `public.payments`, `public.payout_items`.
- **External Integrations**: None.
- **Authorization Checks**: Platform administrator role required.
- **Error Handling**: Read-only transaction; any discrepancy returns structured mismatch details without mutating balances.
- **Final State**: Mathematical verification that for every community:  
  $$\text{wallet\_balance} \equiv \sum \text{gross} - \sum \text{platform\_fee} - \sum \text{verified\_refunds} - \sum \text{settled\_payouts}$$  
  Status badge displayed: "100% CLEAN" or "ANOMALY DETECTED".
- **Existing Tests**: `apps/admin-web/src/pages/FinancialsPage.test.tsx`, `supabase/tests/stage5_financial_reconciliation.test.ts`.
- **Missing Tests**: Automated daily cron execution of 3-way reconciliation emitting alerts on variance.

---

### Workflow 19: Media Upload, Gallery Viewing, and Asynchronous Deletion
- **Entry Point**: Organizer Web Media tab (`/dashboard#media`) or Mobile Community Media.
- **Frontend Files**: [apps/organizer-web/src/components/media/media-section.tsx](file:///Users/shivapraneeth/Documents/community/apps/organizer-web/src/components/media/media-section.tsx), [apps/mobile/lib/widgets/media/community_media_section.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/widgets/media/community_media_section.dart).
- **Backend Functions**: Edge Function `delete-media`, PostgreSQL Table `media_cleanup_jobs`.
- **Database Tables**: `public.media`, `public.media_cleanup_jobs`.
- **External Integrations**: Cloudinary Upload API & Cloudinary Destroy API (`api.cloudinary.com/v1_1/<cloud>/image/destroy`).
- **Authorization Checks**: Media uploader or community owner can delete; file type checked (JPG, PNG, WebP, MP4); file size $\le 15$MB.
- **Error Handling**: Upload failure surfaced to user; deletion failure enqueues job into `media_cleanup_jobs` outbox for background retry.
- **Final State**: Media record removed from database; file removed from Cloudinary CDN.
- **Existing Tests**: `apps/organizer-web/src/components/media/media-section.test.tsx`, `apps/mobile/test/community_media_test.dart`, `supabase/tests/media_cleanup.test.ts`.
- **Missing Tests**: Concurrent upload of $> 10$ media files simultaneously on slow mobile connection.

---

### Workflow 20: Account Deletion, Grace Period, and Scheduled Purge
- **Entry Point**: Mobile App Profile $\to$ "Delete Account".
- **Frontend Files**: [apps/mobile/lib/screens/profile_screen.dart](file:///Users/shivapraneeth/Documents/community/apps/mobile/lib/screens/profile_screen.dart).
- **Backend Functions**: Edge Function `delete-account`, Edge Function `cancel-account-deletion`, Cron Edge Function `purge-deleted-accounts`.
- **Database Tables**: `public.profiles`, `public.registrations`, `public.communities`, `public.media_cleanup_jobs`, `auth.users`.
- **External Integrations**: Cloudinary Destroy API.
- **Authorization Checks**: Authenticated user; sole owner of an active community is blocked from deleting account until community is closed or ownership transferred (`owner_self_delete_guard`).
- **Error Handling**: Community owner error directs user to close community first; cancel deletion restores active status.
- **Final State**: `profiles.deletion_scheduled_at` set to 30 days in future; user signed out; daily cron at 03:17 UTC hard-purges accounts whose 30-day grace period has elapsed.
- **Existing Tests**: `supabase/tests/account_deletion.test.ts`, `supabase/tests/profile_guard_deletion_columns.test.ts`.
- **Missing Tests**: Re-authentication behavior during active grace period when user attempts to book a free event.

