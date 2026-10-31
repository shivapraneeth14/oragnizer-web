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
})
