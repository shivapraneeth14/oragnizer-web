import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import TransactionDetailDrawer, { FinancialTransaction } from "./TransactionDetailDrawer"

const baseTransaction: FinancialTransaction = {
  transaction_id: "payout-dispute-uuid-1",
  created_at: "2026-11-04T15:05:16.000Z",
  transaction_type: "payout_disputed",
  status: "disputed",
  description: "Payout → Bank Transfer",
  reference_id: "UTR1234567",
  secondary_ref: null,
  attendee_name: "Hyderabad Tech Club",
  attendee_email: null,
  attendee_phone: null,
  registration_id: null,
  event_id: null,
  event_title: "General Community Wallet",
  check_in_status: null,
  gross_amount: 10000,
  platform_fee: 0,
  organizer_share: 10000,
  money_in: 0,
  money_out: 10000,
  running_balance: 10000,
  refund_reason: "Funds not credited to my bank account.",
  admin_notes: "Recorded IMPS transfer",
  payment_method: "IMPS",
  bank_details: {
    account_holder: "Hyderabad Tech Club",
    bank_account_number: "9876543210",
    bank_ifsc: "HDFC0001234",
  },
  confirmed_at: "2026-11-04T15:06:00.000Z",
}

describe("TransactionDetailDrawer", () => {
  it("renders nothing when there is no transaction", () => {
    const { container } = render(
      <TransactionDetailDrawer transaction={null} onClose={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("opens the slide-over with audit details for a disputed payout", () => {
    render(<TransactionDetailDrawer transaction={baseTransaction} onClose={vi.fn()} />)

    // The slide-over itself, not a bare status badge.
    expect(screen.getByText("Transaction Audit")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Payout → Bank Transfer" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Close Inspector/i })).toBeInTheDocument()

    // Bank details and reference identifiers.
    expect(screen.getByText("UTR1234567")).toBeInTheDocument()
    expect(screen.getByText("9876543210")).toBeInTheDocument()
    expect(screen.getByText("HDFC0001234")).toBeInTheDocument()

    // Disputed must win over confirmed_at (dispute RPC also stamps confirmed_at).
    expect(screen.getByText(/Funds not credited to my bank account/)).toBeInTheDocument()

    // All four resolution actions are available.
    expect(
      screen.getByRole("button", { name: /Ask Organizer to Re-confirm/i })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Resolve & Reissue/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Cancel & Release/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /More options/i })).toBeInTheDocument()
  })

  it("reveals Force Mark Received under More options", async () => {
    const user = userEvent.setup()
    render(<TransactionDetailDrawer transaction={baseTransaction} onClose={vi.fn()} />)

    expect(screen.queryByRole("button", { name: /Force Mark Received/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /More options/i }))

    expect(screen.getByRole("button", { name: /Force Mark Received/i })).toBeInTheDocument()
  })

  it("opens the reissue modal with a locked amount and a new UTR field", async () => {
    const user = userEvent.setup()
    render(<TransactionDetailDrawer transaction={baseTransaction} onClose={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: /Resolve & Reissue/i }))

    expect(screen.getByRole("heading", { name: /Resolve & Reissue Payout/i })).toBeInTheDocument()
    expect(screen.getByText("Reissue Amount (fixed):")).toBeInTheDocument()
    // The amount appears in both the drawer banner and the reissue summary.
    expect(screen.getAllByText("₹100.00").length).toBeGreaterThan(1)
    expect(screen.getByPlaceholderText("e.g. 426818293541")).toBeInTheDocument()
  })

  it("shows the full panel for a successful ticket sale without payout actions", () => {
    render(
      <TransactionDetailDrawer
        transaction={{
          ...baseTransaction,
          transaction_id: "ticket-sale-uuid",
          transaction_type: "ticket_sale",
          status: "success",
          description: "Ticket Purchase",
          reference_id: "pay_Tw8nAZTyKtM6no",
          secondary_ref: "order_Tw8mmGmcn1SdcU",
          refund_reason: null,
          confirmed_at: null,
          money_in: 10000,
          money_out: 0,
        }}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText("Transaction Audit")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Ticket Purchase" })).toBeInTheDocument()
    expect(screen.getByText("pay_Tw8nAZTyKtM6no")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Resolve & Reissue/i })).not.toBeInTheDocument()
  })

  it("offers Cancel Settlement for a pending payout", () => {
    render(
      <TransactionDetailDrawer
        transaction={{
          ...baseTransaction,
          status: "pending_confirmation",
          refund_reason: null,
          confirmed_at: null,
        }}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByRole("button", { name: /Cancel Settlement/i })).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Ask Organizer to Re-confirm/i })
    ).not.toBeInTheDocument()
  })
})
