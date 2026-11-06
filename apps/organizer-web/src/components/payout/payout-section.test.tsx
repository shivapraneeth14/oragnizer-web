import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import PayoutSection from "./payout-section"
import { server } from "../../test/setup"
import { http, HttpResponse } from "msw"

const BASE_URL = "http://127.0.0.1:54321"

describe("PayoutSection (Organizer Financial Observability & Payout Reconciliation)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders wallet balance and five-dimension settlement overview", async () => {
    render(<PayoutSection communityId="comm_mock_123" />)

    // Check main heading
    expect(screen.getByText("Payouts & Financial Settlements")).toBeInTheDocument()

    // Wait for balance and metrics to load
    await waitFor(() => {
      // Wallet balance card: ₹750
      expect(screen.getByText("₹750")).toBeInTheDocument()
      expect(screen.getByText(/Community Wallet Balance/i)).toBeInTheDocument()
    })

    // Check settlement summary dimensions
    await waitFor(() => {
      expect(screen.getByText("Net Earned")).toBeInTheDocument()
      expect(screen.getByText("In-Flight Pending")).toBeInTheDocument()
      expect(screen.getByText("Uncommitted Balance")).toBeInTheDocument()
    })
  })

  it("renders transaction passbook with filters", async () => {
    const user = userEvent.setup()
    render(<PayoutSection communityId="comm_mock_123" />)

    // Check transaction table renders
    await waitFor(() => {
      expect(screen.getByText(/All Community Financial Transactions/i)).toBeInTheDocument()
      expect(screen.getByText(/Ticket purchase by Bob Taylor/i)).toBeInTheDocument()
    })

    // Filter by Ticket Sales (In)
    const salesFilterBtn = screen.getByRole("button", { name: /Ticket Sales \(In\)/i })
    await user.click(salesFilterBtn)

    await waitFor(() => {
      expect(screen.getByText(/Ticket purchase by Bob Taylor/i)).toBeInTheDocument()
    })
  })

  it("allows organizer to confirm a pending payout", async () => {
    const user = userEvent.setup()
    let confirmCalledWith: Record<string, unknown> | null = null

    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/organizer_confirm_manual_payout`, async ({ request }) => {
        confirmCalledWith = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, payout_id: "tx-payout-pending-1" })
      })
    )

    render(<PayoutSection communityId="comm_mock_123" />)

    // Wait for pending confirmation button in general pending banner
    const confirmBtn = await screen.findByRole("button", { name: /Accept & Confirm Payout/i })
    await user.click(confirmBtn)

    // Check confirmation RPC was dispatched with proper payout_id
    await waitFor(() => {
      expect(confirmCalledWith).toEqual({
        p_payout_id: "tx-payout-pending-1",
      })
      expect(
        screen.getByText(/successfully confirmed and reconciled with your community wallet/i)
      ).toBeInTheDocument()
    })
  })

  it("allows organizer to open dispute modal and submit a dispute reason", async () => {
    const user = userEvent.setup()
    let disputeCalledWith: Record<string, unknown> | null = null

    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/organizer_dispute_manual_payout`, async ({ request }) => {
        disputeCalledWith = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, payout_id: "tx-payout-pending-1", status: "disputed" })
      })
    )

    render(<PayoutSection communityId="comm_mock_123" />)

    // Click Dispute button in general pending banner
    const disputeBtns = await screen.findAllByRole("button", { name: /Dispute/i })
    await user.click(disputeBtns[0])

    // Modal should be open
    await waitFor(() => {
      expect(screen.getByText(/Dispute Manual Settlement/i)).toBeInTheDocument()
    })

    // Enter dispute reason
    const reasonInput = screen.getByPlaceholderText(/Funds not received in linked bank account/i)
    await user.type(reasonInput, "Bank statement shows UTR not credited to account")

    // Submit dispute
    const submitBtn = screen.getByRole("button", { name: /Submit Dispute/i })
    await user.click(submitBtn)

    await waitFor(() => {
      expect(disputeCalledWith).toEqual({
        p_payout_id: "tx-payout-pending-1",
        p_reason: "Bank statement shows UTR not credited to account",
      })
      expect(screen.getByText(/Dispute recorded\. The admin team has been notified/i)).toBeInTheDocument()
    })
  })

  it("handles race condition gracefully when payout is no longer pending", async () => {
    const user = userEvent.setup()

    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/organizer_confirm_manual_payout`, async () => {
        return HttpResponse.json({
          ok: false,
          error: "invalid_payout_status",
          message: "Payout is no longer pending confirmation (current status: success).",
        })
      })
    )

    render(<PayoutSection communityId="comm_mock_123" />)

    const confirmBtn = await screen.findByRole("button", { name: /Accept & Confirm Payout/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(
        screen.getByText(/Payout is no longer pending confirmation \(current status: success\)/i)
      ).toBeInTheDocument()
    })
  })

  it("shows a statement error instead of misleading zero balances when the RPC fails", async () => {
    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/get_organizer_financial_statement`, async () => {
        return HttpResponse.json(
          {
            code: "42P01",
            message: 'relation "calculated_refunds" does not exist',
          },
          { status: 400 }
        )
      })
    )

    render(<PayoutSection communityId="comm_mock_123" />)

    await waitFor(() => {
      expect(screen.getByText(/Financial statement unavailable/i)).toBeInTheDocument()
      expect(screen.getByText(/relation "calculated_refunds" does not exist/i)).toBeInTheDocument()
    })

    // The wallet balance still loads from its own RPC.
    expect(await screen.findByText("₹750")).toBeInTheDocument()

    // A failed statement must not be presented as an empty ledger.
    expect(screen.queryByText(/No transactions match the selected filter/i)).not.toBeInTheDocument()
    expect(screen.getByText(/transaction ledger could not be loaded/i)).toBeInTheDocument()
  })

  it("renders cancelled payout status badge and details correctly", async () => {
    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/get_organizer_financial_statement`, async () => {
        return HttpResponse.json([
          {
            created_at: "2026-10-30T10:00:00Z",
            transaction_id: "tx-cancelled-payout-1",
            transaction_type: "payout_cancelled",
            status: "cancelled",
            description: "Payout → Tech Corp",
            reference_id: "UTR-CANCELLED-99",
            money_in: 0,
            money_out: 0,
            admin_notes: "Cancelled by admin due to incorrect IFSC code",
          },
        ])
      })
    )

    render(<PayoutSection communityId="comm_mock_123" />)

    await waitFor(() => {
      expect(screen.getByText("Cancelled")).toBeInTheDocument()
      expect(screen.getByText("Ref: UTR-CANCELLED-99")).toBeInTheDocument()
    })
  })
})
