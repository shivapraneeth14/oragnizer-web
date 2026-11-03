import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import PayoutDisputeResolutionModal from "./PayoutDisputeResolutionModal"
import { FinancialTransaction } from "./TransactionDetailDrawer"
import { server } from "../test/setup"
import { http, HttpResponse } from "msw"

const BASE_URL = "http://127.0.0.1:54321"

describe("PayoutDisputeResolutionModal (Dispute Resolution & Pending Settlement Cancellation)", () => {
  const mockOnClose = vi.fn()
  const mockOnSuccess = vi.fn()

  const sampleDisputedTx: FinancialTransaction = {
    transaction_id: "payout-dispute-uuid-1",
    created_at: "2026-10-31T04:00:00.000Z",
    transaction_type: "payout_disputed",
    status: "disputed",
    description: "Manual IMPS Payout → Acme Organizer",
    reference_id: "UTR-DISPUTED-123456",
    secondary_ref: null,
    attendee_name: "Acme Community",
    attendee_email: null,
    attendee_phone: null,
    registration_id: null,
    event_id: null,
    event_title: "General Community Wallet",
    check_in_status: null,
    gross_amount: 50000,
    platform_fee: 0,
    organizer_share: 50000,
    money_in: 0,
    money_out: 50000,
    running_balance: 100000,
    refund_reason: "Funds not credited to bank account as of 48h.",
    admin_notes: "Recorded initial IMPS transfer",
    payment_method: "IMPS",
    bank_details: {
      account_holder: "Acme Corp",
      bank_account_number: "9876543210",
      bank_ifsc: "HDFC0001234",
    },
    confirmed_at: null,
  }

  const samplePendingTx: FinancialTransaction = {
    ...sampleDisputedTx,
    transaction_id: "payout-pending-uuid-2",
    transaction_type: "payout_pending",
    status: "pending_confirmation",
    refund_reason: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns null when isOpen is false or transaction is null", () => {
    const { container: closedContainer } = render(
      <PayoutDisputeResolutionModal
        isOpen={false}
        transaction={sampleDisputedTx}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )
    expect(closedContainer).toBeEmptyDOMElement()

    const { container: nullTxContainer } = render(
      <PayoutDisputeResolutionModal
        isOpen={true}
        transaction={null}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )
    expect(nullTxContainer).toBeEmptyDOMElement()
  })

  it("renders disputed settlement summary, dispute claim, and resolution options", () => {
    render(
      <PayoutDisputeResolutionModal
        isOpen={true}
        transaction={sampleDisputedTx}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )

    expect(screen.getByText("Resolve Payout Dispute")).toBeInTheDocument()
    expect(screen.getByText("₹500.00")).toBeInTheDocument()
    expect(screen.getByText("UTR-DISPUTED-123456")).toBeInTheDocument()
    expect(screen.getByText("Funds not credited to bank account as of 48h.")).toBeInTheDocument()
    expect(screen.getByText(/Cancel Disputed Settlement \(Release Reserved Balance\)/i)).toBeInTheDocument()
    expect(screen.getByText(/Confirm Receipt & Debit Wallet/i)).toBeInTheDocument()
  })

  it("requires audit notes of at least 10 characters", async () => {
    const user = userEvent.setup()
    render(
      <PayoutDisputeResolutionModal
        isOpen={true}
        transaction={sampleDisputedTx}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )

    const notesInput = screen.getByPlaceholderText(/Detail the banking investigation/i)
    await user.type(notesInput, "Too short")

    const submitBtn = screen.getByRole("button", { name: /Cancel Settlement & Unlock Funds/i })
    await user.click(submitBtn)

    expect(
      screen.getByText(/Audit notes and explanation are required \(minimum 10 characters\)/i)
    ).toBeInTheDocument()
    expect(mockOnSuccess).not.toHaveBeenCalled()
  })

  it("dispatches admin_resolve_payout_dispute when cancelling a disputed payout", async () => {
    const user = userEvent.setup()
    let rpcPayload: Record<string, unknown> | null = null

    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/admin_resolve_payout_dispute`, async ({ request }) => {
        rpcPayload = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({
          ok: true,
          status: "cancelled",
          unreserved_amount: 50000,
        })
      })
    )

    render(
      <PayoutDisputeResolutionModal
        isOpen={true}
        transaction={sampleDisputedTx}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )

    const notesInput = screen.getByPlaceholderText(/Detail the banking investigation/i)
    await user.type(notesInput, "Bank confirmed transfer bounced and was reversed to treasury.")

    const submitBtn = screen.getByRole("button", { name: /Cancel Settlement & Unlock Funds/i })
    await user.click(submitBtn)

    await waitFor(() => {
      expect(rpcPayload).toEqual({
        p_payout_id: "payout-dispute-uuid-1",
        p_resolution: "cancel_disputed_payout",
        p_resolution_notes: "Bank confirmed transfer bounced and was reversed to treasury.",
      })
      expect(mockOnSuccess).toHaveBeenCalledTimes(1)
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })
  })

  it("dispatches admin_resolve_payout_dispute with confirm_received_payout", async () => {
    const user = userEvent.setup()
    let rpcPayload: Record<string, unknown> | null = null

    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/admin_resolve_payout_dispute`, async ({ request }) => {
        rpcPayload = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({
          ok: true,
          status: "success",
          debited_amount: 50000,
        })
      })
    )

    render(
      <PayoutDisputeResolutionModal
        isOpen={true}
        transaction={sampleDisputedTx}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )

    // Select "Confirm Receipt & Debit Wallet"
    const confirmRadio = screen.getByLabelText(/Confirm Receipt & Debit Wallet/i)
    await user.click(confirmRadio)

    const notesInput = screen.getByPlaceholderText(/Detail the banking investigation/i)
    await user.type(notesInput, "Organizer confirmed phone call verification; statement verified.")

    const submitBtn = screen.getByRole("button", { name: /Confirm & Debit Wallet/i })
    await user.click(submitBtn)

    await waitFor(() => {
      expect(rpcPayload).toEqual({
        p_payout_id: "payout-dispute-uuid-1",
        p_resolution: "confirm_received_payout",
        p_resolution_notes: "Organizer confirmed phone call verification; statement verified.",
      })
      expect(mockOnSuccess).toHaveBeenCalledTimes(1)
    })
  })

  it("cancels pending unconfirmed payout via admin_cancel_manual_payout", async () => {
    const user = userEvent.setup()
    let rpcPayload: Record<string, unknown> | null = null

    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/admin_cancel_manual_payout`, async ({ request }) => {
        rpcPayload = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({
          ok: true,
          payout_id: "payout-pending-uuid-2",
          status: "cancelled",
        })
      })
    )

    render(
      <PayoutDisputeResolutionModal
        isOpen={true}
        transaction={samplePendingTx}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )

    expect(screen.getByRole("heading", { name: "Cancel Pending Settlement" })).toBeInTheDocument()

    const notesInput = screen.getByPlaceholderText(/Detail the reason for cancelling this pending payout/i)
    await user.type(notesInput, "Typo in recorded UTR number; re-entering transaction.")

    const submitBtn = screen.getByRole("button", { name: /Cancel Pending Settlement/i })
    await user.click(submitBtn)

    await waitFor(() => {
      expect(rpcPayload).toEqual({
        p_payout_id: "payout-pending-uuid-2",
        p_cancel_reason: "Typo in recorded UTR number; re-entering transaction.",
      })
      expect(mockOnSuccess).toHaveBeenCalledTimes(1)
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })
  })

  it("handles RPC failure properly", async () => {
    const user = userEvent.setup()

    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/admin_cancel_manual_payout`, async () => {
        return HttpResponse.json({
          ok: false,
          error: "invalid_payout_status",
          message: "Only pending payouts can be cancelled.",
        })
      })
    )

    render(
      <PayoutDisputeResolutionModal
        isOpen={true}
        transaction={samplePendingTx}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )

    const notesInput = screen.getByPlaceholderText(/Detail the reason for cancelling this pending payout/i)
    await user.type(notesInput, "Cancelling duplicate record before confirmation.")

    const submitBtn = screen.getByRole("button", { name: /Cancel Pending Settlement/i })
    await user.click(submitBtn)

    await waitFor(() => {
      expect(screen.getByText("Only pending payouts can be cancelled.")).toBeInTheDocument()
      expect(mockOnSuccess).not.toHaveBeenCalled()
    })
  })
})
