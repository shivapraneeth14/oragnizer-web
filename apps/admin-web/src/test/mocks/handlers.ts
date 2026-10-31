import { http, HttpResponse } from "msw"

const BASE_URL = "http://127.0.0.1:54321"

export const handlers = [
  // Auth endpoints
  http.get(`${BASE_URL}/auth/v1/user`, () => {
    return HttpResponse.json({
      id: "admin-user-id",
      email: "admin@cluvo.com",
      app_metadata: { provider: "email" },
      user_metadata: { first_name: "Admin", last_name: "Superuser" },
    })
  }),

  http.post(`${BASE_URL}/auth/v1/token`, async ({ request }) => {
    const url = new URL(request.url)
    const grantType = url.searchParams.get("grant_type")
    if (grantType === "password") {
      const body = (await request.json()) as Record<string, string>
      if (body.password === "WrongPassword!") {
        return HttpResponse.json({ error: "Invalid login credentials", message: "Invalid login credentials" }, { status: 400 })
      }
      if (body.email === "banned@cluvo.com") {
        return HttpResponse.json({ error: "User is banned", message: "User is banned" }, { status: 400 })
      }
      return HttpResponse.json({
        access_token: "mock-admin-token",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "mock-refresh-token",
        user: {
          id: "admin-user-id",
          email: body.email,
        },
      })
    }
    return HttpResponse.json({ error: "Unsupported grant type" }, { status: 400 })
  }),

  http.post(`${BASE_URL}/auth/v1/recover`, () => {
    return HttpResponse.json({})
  }),

  http.put(`${BASE_URL}/auth/v1/user`, () => {
    return HttpResponse.json({
      id: "admin-user-id",
      email: "admin@cluvo.com",
    })
  }),

  http.post(`${BASE_URL}/auth/v1/logout`, () => {
    return new HttpResponse(null, { status: 204 })
  }),

  // Supabase RPCs
  http.post(`${BASE_URL}/rest/v1/rpc/is_admin_user`, () => {
    return HttpResponse.json(true)
  }),

  http.post(`${BASE_URL}/rest/v1/rpc/admin_record_manual_payout`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    const amount = Number(body.p_amount)
    if (amount <= 0) {
      return HttpResponse.json({ ok: false, error: "Amount must be greater than 0" }, { status: 400 })
    }
    if (amount > 10000000) {
      // Exceeds available balance (e.g. over-allocation check)
      return HttpResponse.json({
        ok: false,
        error: "insufficient_uncommitted_balance",
        message: "Requested payout amount exceeds available uncommitted wallet balance.",
      })
    }
    return HttpResponse.json({
      ok: true,
      payout_id: "payout_mock_success_123",
      remaining_wallet_balance: 50000,
    })
  }),

  http.post(`${BASE_URL}/rest/v1/rpc/admin_resolve_refund_task`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    if (!body.p_task_id) {
      return HttpResponse.json({ ok: false, error: "Task ID is required" }, { status: 400 })
    }
    if (body.p_resolution_type === "adopt_provider_refund" && !body.p_razorpay_refund_id) {
      return HttpResponse.json({ ok: false, error: "Razorpay refund ID is required" }, { status: 400 })
    }
    return HttpResponse.json({
      ok: true,
      task_id: body.p_task_id,
      resolution: body.p_resolution_type,
    })
  }),

  http.post(`${BASE_URL}/rest/v1/rpc/get_financial_observability_kpis`, () => {
    return HttpResponse.json({
      system_health: "HEALTHY",
      total_stored_wallet_paise: 94000,
      total_pending_payouts_paise: 0,
      total_disputed_payouts_paise: 0,
      total_uncommitted_payable_paise: 94000,
      disputed_payouts_count: 0,
      alert_queue_tasks_count: 0,
      total_communities_count: 5,
      timestamp: new Date().toISOString(),
    })
  }),

  http.post(`${BASE_URL}/rest/v1/rpc/get_admin_communities`, () => {
    return HttpResponse.json([
      {
        id: "comm_mock_admin_1",
        name: "Admin Audit Community",
        owner_id: "owner-1",
        wallet_balance: 100000,
        deleted_at: null,
        is_hidden: false,
      },
      {
        id: "comm_mock_admin_2",
        name: "Bangalore Dev Guild",
        owner_id: "owner-2",
        wallet_balance: 250000,
        deleted_at: null,
        is_hidden: false,
      },
    ])
  }),

  http.post(`${BASE_URL}/rest/v1/rpc/get_community_financials`, () => {
    return HttpResponse.json([
      {
        community_id: "comm_mock_admin_1",
        wallet_balance: 100000,
      },
    ])
  }),

  http.post(`${BASE_URL}/rest/v1/rpc/get_admin_financial_statement`, () => {
    return HttpResponse.json([
      {
        transaction_id: "tx-ticket-1",
        id: "tx-ticket-1",
        event_id: "event_mock_admin_1",
        event_title: "Admin Super Event",
        transaction_type: "ticket_sale",
        money_in: 94000,
        money_out: 0,
        gross_amount: 100000,
        platform_fee: 6000,
        running_balance: 94000,
        balance_after: 94000,
        status: "success",
        created_at: new Date().toISOString(),
        payment_id: "pay_111",
      },
      {
        transaction_id: "tx-refund-1",
        id: "tx-refund-1",
        event_id: "event_mock_admin_1",
        event_title: "Admin Super Event",
        transaction_type: "refund",
        money_in: 0,
        money_out: 50000,
        gross_amount: 50000,
        platform_fee: 0,
        running_balance: 44000,
        balance_after: 44000,
        status: "success",
        created_at: new Date().toISOString(),
        payment_id: "pay_111",
      },
      {
        transaction_id: "tx-payout-1",
        id: "tx-payout-1",
        event_id: "event_mock_admin_1",
        event_title: "Admin Super Event",
        transaction_type: "payout_manual",
        money_in: 0,
        money_out: 20000,
        gross_amount: 0,
        platform_fee: 0,
        running_balance: 24000,
        balance_after: 24000,
        status: "success",
        created_at: new Date().toISOString(),
      },
    ])
  }),

  http.post(`${BASE_URL}/rest/v1/rpc/run_financial_reconciliation`, () => {
    return HttpResponse.json({
      reconciliation_timestamp: new Date().toISOString(),
      summary: {
        total_communities_audited: 2,
        clean_communities_count: 2,
        discrepant_communities_count: 0,
        total_payments_audited: 15,
        total_refunds_audited: 3,
        total_payouts_audited: 2,
        total_discrepancies_found: 0,
      },
      settlement_overview: {
        gross_revenue_paise: 500000,
        platform_fee_paise: 30000,
        organizer_share_paise: 470000,
        customer_refunds_paise: 25000,
        organizer_refund_debits_paise: 25000,
        confirmed_payouts_paise: 100000,
        pending_payouts_paise: 0,
        disputed_payouts_paise: 0,
        total_stored_wallet_paise: 345000,
        total_uncommitted_payable_paise: 345000,
      },
      three_way_wallet_reconciliation: [
        {
          community_id: "comm_mock_admin_1",
          community_name: "Admin Audit Community",
          stored_wallet_balance: 100000,
          audit_ledger_balance: 100000,
          primary_transaction_balance: 100000,
          in_flight_pending_payouts: 0,
          disputed_payouts: 0,
          uncommitted_wallet_balance: 100000,
          status: "CLEAN",
          stored_vs_ledger_diff: 0,
          stored_vs_primary_diff: 0,
          ledger_vs_primary_diff: 0,
          discrepancy_types: [],
          metrics: {
            gross_sales: 100000,
            platform_fees: 6000,
            organizer_sales_earned: 94000,
            customer_refunds: 0,
            organizer_refund_debits: 0,
            confirmed_payouts: 0,
            payment_count: 10,
            refund_count: 0,
            payout_count: 0,
          },
        },
      ],
      payment_discrepancies: [],
      refund_discrepancies: [],
      settlement_discrepancies: [],
    })
  }),

  http.post(`${BASE_URL}/rest/v1/rpc/reconcile_all_wallets`, () => {
    return HttpResponse.json({
      reconciliation_timestamp: new Date().toISOString(),
      summary: {
        total_communities_audited: 5,
        clean_communities_count: 5,
        discrepant_communities_count: 0,
        total_payments_audited: 20,
        total_refunds_audited: 2,
        total_payouts_audited: 1,
        total_discrepancies_found: 0,
      },
      settlement_overview: {
        gross_revenue_paise: 200000,
        platform_fee_paise: 12000,
        organizer_share_paise: 188000,
        refunded_amount_paise: 20000,
        settled_payouts_paise: 74000,
        uncommitted_payable_paise: 94000,
      },
      discrepancies: [],
    })
  }),

  // Edge Functions
  http.post(`${BASE_URL}/functions/v1/notify-payout`, () => {
    return HttpResponse.json({ success: true })
  }),

  http.post(`${BASE_URL}/functions/v1/admin-delete-community`, () => {
    return HttpResponse.json({ success: true })
  }),

  http.post(`${BASE_URL}/functions/v1/admin-cancel-community-deletion`, () => {
    return HttpResponse.json({ success: true })
  }),

  http.post(`${BASE_URL}/functions/v1/admin-delete-user`, () => {
    return HttpResponse.json({ success: true })
  }),

  // REST Tables
  http.get(`${BASE_URL}/rest/v1/admin_alerts`, () => {
    return HttpResponse.json([])
  }),

  http.head(`${BASE_URL}/rest/v1/admin_alerts`, () => {
    return new HttpResponse(null, {
      status: 200,
      headers: {
        "Content-Range": "0-0/0",
      },
    })
  }),

  http.get(`${BASE_URL}/rest/v1/communities`, () => {
    return HttpResponse.json([
      {
        id: "comm_mock_admin_1",
        name: "Admin Audit Community",
        owner_id: "owner-1",
        wallet_balance: 100000,
        created_at: new Date().toISOString(),
      },
    ])
  }),

  http.get(`${BASE_URL}/rest/v1/events`, () => {
    return HttpResponse.json([
      {
        id: "event_mock_admin_1",
        community_id: "comm_mock_admin_1",
        title: "Admin Super Event",
        start_date: new Date(Date.now() + 86400000).toISOString(),
        price: 1000,
        status: "published",
      },
    ])
  }),

  http.get(`${BASE_URL}/rest/v1/profiles`, () => {
    return HttpResponse.json([
      {
        id: "owner-1",
        email: "owner@example.com",
        first_name: "Community",
        last_name: "Owner",
        is_admin: false,
      },
      {
        id: "admin-user-id",
        email: "admin@cluvo.com",
        first_name: "Admin",
        last_name: "User",
        is_admin: true,
      },
    ])
  }),

  http.get(`${BASE_URL}/rest/v1/refund_task_queue`, () => {
    return HttpResponse.json([])
  }),

  http.get(`${BASE_URL}/rest/v1/community_beneficiaries`, () => {
    return HttpResponse.json([
      {
        id: "ben-1",
        community_id: "comm_mock_admin_1",
        account_holder: "Acme Tech Services",
        bank_account_number: "987654321012",
        bank_ifsc: "HDFC0000123",
        label: "Main Business Account",
        is_active: true,
      },
    ])
  }),

  http.get(`${BASE_URL}/rest/v1/content_reports`, () => {
    return HttpResponse.json([])
  }),
]
