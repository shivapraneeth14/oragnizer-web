import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import PayoutDisputeResolutionModal from "./PayoutDisputeResolutionModal"
import { FinancialTransaction } from "./TransactionDetailDrawer"
import { server } from "../test/setup"
import { http, HttpResponse } from "msw"

const BASE_URL = "http://127.0.0.1:54321"

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

describe("PayoutDisputeResolutionModal", () => {
  const mockOnClose = vi.fn()
  const mockOnSuccess = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns null when isOpen is false or transaction is null", () => {
    const { container: closedContainer } = render(
      <PayoutDisputeResolutionModal
        isOpen={false}
        transaction={sampleDisputedTx}
        mode="cancel"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )
    expect(closedContainer).toBeEmptyDOMElement()

    const { container: nullTxContainer } = render(
      <PayoutDisputeResolutionModal
        isOpen={true}
        transaction={null}
        mode="cancel"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )
    expect(nullTxContainer).toBeEmptyDOMElement()
  })

  it("renders the disputed amount, UTR and reason in reconfirm mode", () => {
    render(
      <PayoutDisputeResolutionModal
        isOpen={true}
        transaction={sampleDisputedTx}
        mode="reconfirm"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )

    expect(screen.getByRole("heading", { name: "Ask Organizer to Re-confirm" })).toBeInTheDocument()
    expect(screen.getByText("₹500.00")).toBeInTheDocument()
    expect(screen.getByText("UTR-DISPUTED-123456")).toBeInTheDocument()
    expect(screen.getByText("Funds not credited to bank account as of 48h.")).toBeInTheDocument()
  })

  it("rejects audit notes shorter than 10 characters", async () => {
    const user = userEvent.setup()
    render(
      <PayoutDisputeResolutionModal
        isOpen={true}
        transaction={sampleDisputedTx}
        mode="reconfirm"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )

    await user.type(screen.getByPlaceholderText(/Detail the banking investigation/i), "Too short")
    await user.click(screen.getByRole("button", { name: /Request Re-confirmation/i }))

    expect(
      screen.getByText(/Audit notes and explanation are required \(minimum 10 characters\)/i)
    ).toBeInTheDocument()
    expect(mockOnSuccess).not.toHaveBeenCalled()
  })

  it("reconfirms via the same payout row and notifies the organizer", async () => {
    const user = userEvent.setup()
    let rpcPayload: Record<string, unknown> | null = null
    let notifiedPayoutId: unknown = null

    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/admin_request_payout_reconfirmation`, async ({ request }) => {
        rpcPayload = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, status: "pending_confirmation" })
      }),
      http.post(`${BASE_URL}/functions/v1/notify-payout`, async ({ request }) => {
        notifiedPayoutId = ((await request.json()) as Record<string, unknown>).payout_id
        return HttpResponse.json({ ok: true })
      })
    )

    render(
      <PayoutDisputeResolutionModal
        isOpen={true}
        transaction={sampleDisputedTx}
        mode="reconfirm"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )

    await user.type(
      screen.getByPlaceholderText(/Detail the banking investigation/i),
      "Bank statement confirms the transfer was delivered to the organizer account."
    )
    await user.click(screen.getByRole("button", { name: /Request Re-confirmation/i }))

    await waitFor(() => {
      expect(rpcPayload).toEqual({
        p_payout_id: "payout-dispute-uuid-1",
        p_admin_notes: "Bank statement confirms the transfer was delivered to the organizer account.",
      })
      expect(notifiedPayoutId).toBe("payout-dispute-uuid-1")
      expect(mockOnSuccess).toHaveBeenCalledTimes(1)
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })
  })

  it("cancels a disputed payout and releases the hold without debiting the wallet", async () => {
    const user = userEvent.setup()
    let rpcPayload: Record<string, unknown> | null = null

    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/admin_resolve_payout_dispute`, async ({ request }) => {
        rpcPayload = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, status: "cancelled", unreserved_amount: 50000 })
      })
    )

    render(
      <PayoutDisputeResolutionModal
        isOpen={true}
        transaction={sampleDisputedTx}
        mode="cancel"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )

    await user.type(
      screen.getByPlaceholderText(/Detail the reason for cancelling this disputed payout/i),
      "Bank confirmed transfer bounced and was reversed to treasury."
    )
    await user.click(screen.getByRole("button", { name: /Cancel Settlement & Release Funds/i }))

    await waitFor(() => {
      expect(rpcPayload).toEqual({
        p_payout_id: "payout-dispute-uuid-1",
        p_resolution: "cancel_disputed_payout",
        p_resolution_notes: "Bank confirmed transfer bounced and was reversed to treasury.",
      })
      expect(mockOnSuccess).toHaveBeenCalledTimes(1)
    })
  })

  it("force-marks a disputed payout received and debits the wallet once", async () => {
    const user = userEvent.setup()
    let rpcPayload: Record<string, unknown> | null = null

    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/admin_resolve_payout_dispute`, async ({ request }) => {
        rpcPayload = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, status: "success", debited_amount: 50000 })
      })
    )

    render(
      <PayoutDisputeResolutionModal
        isOpen={true}
        transaction={sampleDisputedTx}
        mode="force_received"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )

    expect(screen.getByRole("heading", { name: "Force Mark Received" })).toBeInTheDocument()

    await user.type(
      screen.getByPlaceholderText(/Detail the bank statement reference/i),
      "Statement dated 30 Oct confirms credit; verified against account 9876543210."
    )
    await user.click(screen.getByRole("button", { name: /Mark as Received/i }))

    await waitFor(() => {
      expect(rpcPayload).toEqual({
        p_payout_id: "payout-dispute-uuid-1",
        p_resolution: "confirm_received_payout",
        p_resolution_notes:
          "Statement dated 30 Oct confirms credit; verified against account 9876543210.",
      })
      expect(mockOnSuccess).toHaveBeenCalledTimes(1)
    })
  })

  it("cancels a pending payout via admin_cancel_manual_payout", async () => {
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
        mode="cancel_pending"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )

    expect(screen.getByRole("heading", { name: "Cancel Pending Settlement" })).toBeInTheDocument()

    await user.type(
      screen.getByPlaceholderText(/Detail the reason for cancelling this pending payout/i),
      "Typo in recorded UTR number; re-entering transaction."
    )
    await user.click(screen.getByRole("button", { name: /^Cancel Pending Settlement$/i }))

    await waitFor(() => {
      expect(rpcPayload).toEqual({
        p_payout_id: "payout-pending-uuid-2",
        p_cancel_reason: "Typo in recorded UTR number; re-entering transaction.",
      })
      expect(mockOnSuccess).toHaveBeenCalledTimes(1)
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })
  })

  it("surfaces the RPC error message and does not report success", async () => {
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
        mode="cancel_pending"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    )

    await user.type(
      screen.getByPlaceholderText(/Detail the reason for cancelling this pending payout/i),
      "Cancelling duplicate record before confirmation."
    )
    await user.click(screen.getByRole("button", { name: /^Cancel Pending Settlement$/i }))

    await waitFor(() => {
      expect(screen.getByText("Only pending payouts can be cancelled.")).toBeInTheDocument()
      expect(mockOnSuccess).not.toHaveBeenCalled()
    })
  })
})
