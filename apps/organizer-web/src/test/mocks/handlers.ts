import { http, HttpResponse } from "msw"

const BASE_URL = "http://127.0.0.1:54321"

export const handlers = [
  // Auth endpoints
  http.get(`${BASE_URL}/auth/v1/user`, () => {
    return HttpResponse.json({
      id: "test-user-id",
      email: "organizer@example.com",
      app_metadata: { provider: "google" },
      user_metadata: { first_name: "Organizer", last_name: "User" },
    })
  }),

  http.post(`${BASE_URL}/auth/v1/logout`, () => {
    return new HttpResponse(null, { status: 204 })
  }),

  // Edge Functions
  http.post(`${BASE_URL}/functions/v1/check-organizer`, () => {
    return HttpResponse.json({
      ok: true,
      organizer: true,
      deletion_grace: false,
      message: "Organizer verified",
    })
  }),

  http.post(`${BASE_URL}/functions/v1/record-consent`, () => {
    return HttpResponse.json({ ok: true, success: true })
  }),

  http.post(`${BASE_URL}/functions/v1/check-username`, () => {
    return HttpResponse.json({ available: true })
  }),

  http.post(`${BASE_URL}/functions/v1/check-community-name`, () => {
    return HttpResponse.json({ available: true })
  }),

  http.post(`${BASE_URL}/functions/v1/create-beneficiary`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    if (!body.bank_account_holder || !body.bank_ifsc || !body.bank_account_number) {
      return HttpResponse.json({ error: "All bank fields are required" }, { status: 400 })
    }
    return HttpResponse.json({ success: true, beneficiary_id: "ben_mock_123" })
  }),

  http.post(`${BASE_URL}/functions/v1/switch-active-beneficiary`, () => {
    return HttpResponse.json({ success: true })
  }),

  http.post(`${BASE_URL}/functions/v1/remove-beneficiary`, () => {
    return HttpResponse.json({ success: true })
  }),

  http.post(`${BASE_URL}/functions/v1/cancel-event`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    if (!body.event_id) {
      return HttpResponse.json({ error: "event_id is required" }, { status: 400 })
    }
    return HttpResponse.json({
      success: true,
      job_id: "job_cancel_mock_123",
      total_refunds_eligible: 2,
    })
  }),

  http.post(`${BASE_URL}/functions/v1/remove-member`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    if (body.target_user_id === "owner-id") {
      return HttpResponse.json({ error: "Cannot remove the community owner" }, { status: 403 })
    }
    return HttpResponse.json({ success: true })
  }),

  http.post(`${BASE_URL}/functions/v1/check-in`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    if (body.qr_code === "INVALID_QR") {
      return HttpResponse.json({ error: "Ticket not found or invalid" }, { status: 404 })
    }
    if (body.qr_code === "ALREADY_CHECKED_IN") {
      return HttpResponse.json({
        success: false,
        error: "Attendee already checked in",
        attendee_name: "Jane Doe",
      }, { status: 400 })
    }
    return HttpResponse.json({
      success: true,
      attendee_name: "John Attendee",
      event_title: "Tech Summit 2026",
    })
  }),

  http.post(`${BASE_URL}/functions/v1/delete-media`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    if (body.public_id === "active-avatar-id" || body.public_id === "active-banner-id") {
      return HttpResponse.json({ error: "Cannot destroy active community asset" }, { status: 403 })
    }
    return HttpResponse.json({ success: true })
  }),

  // RPC Endpoints
  http.get(`${BASE_URL}/realtime/v1/websocket`, () => {
    return new HttpResponse(null, { status: 200 })
  }),

  http.post(`${BASE_URL}/rest/v1/rpc/get_community_financials`, () => {
    return HttpResponse.json([
      {
        community_id: "comm_mock_123",
        wallet_balance: 75000, // ₹750.00
      },
    ])
  }),

  http.post(`${BASE_URL}/rest/v1/rpc/get_organizer_financial_statement`, () => {
    return HttpResponse.json([
      {
        transaction_id: "tx-ticket-sale-1",
        created_at: new Date().toISOString(),
        transaction_type: "ticket_sale",
        status: "success",
        description: "Ticket purchase by Bob Taylor",
        reference_id: "pay_RazorpayTicket1",
        event_id: "event_mock_123",
        event_title: "Test Workshop",
        gross_amount: 50000,
        platform_fee: 3000,
        organizer_share: 47000,
        money_in: 47000,
        money_out: 0,
      },
      {
        transaction_id: "tx-payout-pending-1",
        created_at: new Date().toISOString(),
        transaction_type: "payout_pending",
        status: "pending_confirmation",
        description: "Direct Bank Transfer UTR123456",
        reference_id: "UTR123456",
        event_id: null,
        event_title: null,
        gross_amount: 25000,
        platform_fee: 0,
        organizer_share: 25000,
        money_in: 0,
        money_out: 25000,
      },
    ])
  }),

  http.post(`${BASE_URL}/rest/v1/rpc/organizer_confirm_manual_payout`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    if (!body.p_payout_id) {
      return HttpResponse.json({ ok: false, error: "Payout ID required" }, { status: 400 })
    }
    return HttpResponse.json({ ok: true, payout_id: body.p_payout_id })
  }),

  http.post(`${BASE_URL}/rest/v1/rpc/organizer_dispute_manual_payout`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    if (!body.p_payout_id || !body.p_reason) {
      return HttpResponse.json({ ok: false, error: "Payout ID and reason required" }, { status: 400 })
    }
    return HttpResponse.json({ ok: true, payout_id: body.p_payout_id, status: "disputed" })
  }),

  // Supabase REST endpoints
  http.get(`${BASE_URL}/rest/v1/communities`, () => {
    return HttpResponse.json([
      {
        id: "comm_mock_123",
        name: "Test Community",
        owner_id: "test-user-id",
        member_count: 42,
        is_hidden: false,
        created_at: new Date().toISOString(),
      },
    ])
  }),

  http.get(`${BASE_URL}/rest/v1/community_members`, () => {
    return HttpResponse.json([
      {
        user_id: "member-1",
        role: "MEMBER",
        joined_at: new Date().toISOString(),
        profiles: { first_name: "Alice", last_name: "Smith", email: "alice@example.com" },
      },
    ])
  }),

  http.get(`${BASE_URL}/rest/v1/events`, () => {
    return HttpResponse.json([
      {
        id: "event_mock_123",
        community_id: "comm_mock_123",
        title: "Test Workshop",
        description: "Test description",
        price: 500,
        capacity: 50,
        booked_count: 10,
        status: "published",
        start_date: new Date(Date.now() + 86400000).toISOString(),
        end_date: new Date(Date.now() + 90000000).toISOString(),
      },
    ])
  }),

  http.get(`${BASE_URL}/rest/v1/community_beneficiaries`, () => {
    return HttpResponse.json([
      {
        id: "ben_mock_1",
        community_id: "comm_mock_123",
        account_holder: "Test Organizer",
        bank_account_number: "1234567890",
        bank_ifsc: "HDFC0001234",
        label: "Primary Account",
        is_active: true,
      },
    ])
  }),

  http.get(`${BASE_URL}/rest/v1/registrations`, () => {
    return HttpResponse.json([
      {
        id: "reg_mock_1",
        event_id: "event_mock_123",
        user_id: "user-1",
        status: "confirmed",
        payments: [{ amount: 50000, status: "success", organizer_share: 47000 }],
        profiles: { first_name: "Bob", last_name: "Taylor", email: "bob@example.com" },
      },
    ])
  }),

  http.get(`${BASE_URL}/rest/v1/event_cancellation_jobs`, () => {
    return HttpResponse.json({
      id: "job_cancel_mock_123",
      event_id: "event_mock_123",
      status: "completed",
      total_refunds_eligible: 2,
      refunds_succeeded: 2,
      refunds_failed: 0,
      refunds_uncertain: 0,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
  }),

  http.get(`${BASE_URL}/rest/v1/media`, () => {
    return HttpResponse.json([])
  }),

  http.delete(`${BASE_URL}/rest/v1/media`, () => {
    return new HttpResponse(null, { status: 204 })
  }),
]
