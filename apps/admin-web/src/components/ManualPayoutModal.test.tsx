import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import ManualPayoutModal, { type EventSettlementMeta } from "./ManualPayoutModal"
import { server } from "../test/setup"
import { http, HttpResponse } from "msw"

const BASE_URL = "http://127.0.0.1:54321"

describe("ManualPayoutModal (Financial Invariants & Security)", () => {
  const mockOnClose = vi.fn()
  const mockOnSuccess = vi.fn()

  const stableCommunity = {
    id: "comm-fin-123",
    name: "Bangalore Tech Hub",
    wallet_balance: 100000, // 100,000 paise = ₹1000.00
  }

  const stableEvents = [
    { id: "event-1", title: "React Meetup" },
    { id: "event-2", title: "Go Workshop" },
  ]

  const stableSummaries: EventSettlementMeta[] = [
    {
      id: "event-1",
      title: "React Meetup",
      gross: 60000,
      platformFee: 3600,
      refunds: 0,
      settled: 0,
      pending: 0,
      remainingBalance: 56400,
    },
  ]

  const stableBeneficiary = {
    account_holder: "Acme Tech Services",
    bank_account_number: "987654321012",
    bank_ifsc: "HDFC0000123",
    label: "Main Business Account",
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders community information and converts wallet balance to rupees accurately", () => {
    render(
      <ManualPayoutModal
        isOpen={true}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
        community={stableCommunity}
        events={stableEvents}
        eventSummaries={stableSummaries}
        beneficiary={stableBeneficiary}
      />
    )

    expect(screen.getByText("Record Manual Settlement / Payout")).toBeInTheDocument()
    expect(screen.getByText("Bangalore Tech Hub")).toBeInTheDocument()
    // 100,000 paise = ₹1,000.00
    expect(screen.getByText("₹1,000.00")).toBeInTheDocument()
  })

  it("rejects payout submission when amount is empty or zero", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ManualPayoutModal
        isOpen={true}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
        community={stableCommunity}
        events={stableEvents}
        eventSummaries={stableSummaries}
        beneficiary={stableBeneficiary}
      />
    )

    const form = container.querySelector("form")!
    form.noValidate = true

    const amountInput = screen.getByPlaceholderText("0.00")
    await user.clear(amountInput)

    fireEvent.submit(form)

    expect(await screen.findByText(/Please enter a valid payout amount greater than ₹0/i)).toBeInTheDocument()
    expect(mockOnSuccess).not.toHaveBeenCalled()
  })

  it("warns administrator when payout amount exceeds available wallet balance", async () => {
    render(
      <ManualPayoutModal
        isOpen={true}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
        community={stableCommunity}
        events={stableEvents}
        eventSummaries={stableSummaries}
        beneficiary={stableBeneficiary}
      />
    )

    const amountInput = screen.getByPlaceholderText("0.00")
    // Wallet is ₹1,000 (100000 paise). Enter ₹1,500
    fireEvent.change(amountInput, { target: { value: "1500" } })

    expect(await screen.findByText(/exceeds available wallet balance/i)).toBeInTheDocument()
  })

  it("requires Banking UTR when Bank Transfer channel is selected", async () => {
    const { container } = render(
      <ManualPayoutModal
        isOpen={true}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
        community={stableCommunity}
        events={stableEvents}
        eventSummaries={stableSummaries}
        beneficiary={stableBeneficiary}
      />
    )

    const form = container.querySelector("form")!
    form.noValidate = true

    const amountInput = screen.getByPlaceholderText("0.00")
    fireEvent.change(amountInput, { target: { value: "500" } })

    fireEvent.submit(form)

    expect(await screen.findByText(/Please provide the Banking UTR or Transaction Reference Number/i)).toBeInTheDocument()
    expect(mockOnSuccess).not.toHaveBeenCalled()
  })

  it("requires UPI ID and UTR when UPI channel is selected", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ManualPayoutModal
        isOpen={true}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
        community={stableCommunity}
        events={stableEvents}
        eventSummaries={stableSummaries}
        beneficiary={stableBeneficiary}
      />
    )

    const form = container.querySelector("form")!
    form.noValidate = true

    const amountInput = screen.getByPlaceholderText("0.00")
    fireEvent.change(amountInput, { target: { value: "250" } })

    // Switch to UPI channel button
    const upiBtn = screen.getByRole("button", { name: /UPI Transfer/i })
    await user.click(upiBtn)

    fireEvent.submit(form)

    expect(await screen.findByText(/Please provide the Recipient UPI ID/i)).toBeInTheDocument()
  })

  it("converts rupees to integer paise and records manual payout successfully", async () => {
    let capturedPayload: Record<string, unknown> | null = null

    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/admin_record_manual_payout`, async ({ request }) => {
        capturedPayload = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({
          ok: true,
          payout_id: "payout_captured_123",
          remaining_wallet_balance: 50000,
        })
      })
    )

    const user = userEvent.setup()
    render(
      <ManualPayoutModal
        isOpen={true}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
        community={stableCommunity}
        events={stableEvents}
        eventSummaries={stableSummaries}
        beneficiary={stableBeneficiary}
      />
    )

    const amountInput = screen.getByPlaceholderText("0.00")
    await user.clear(amountInput)
    // Enter ₹500.50 -> must convert to 50050 paise
    await user.type(amountInput, "500.50")

    const utrInput = screen.getByPlaceholderText("e.g. UTR1234567890")
    await user.type(utrInput, "UTR20261031TEST")

    const notesInput = screen.getByPlaceholderText(/e\.g\. Transferred via Corporate NetBanking/i)
    await user.type(notesInput, "Milestone payout release")

    const submitBtn = screen.getByRole("button", { name: /Record Payout & Notify Organizer/i })
    await user.click(submitBtn)

    await waitFor(() => {
      expect(mockOnSuccess).toHaveBeenCalledTimes(1)
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })

    // Verify mathematical invariant: rupees converted to integer paise
    expect(capturedPayload).not.null
    expect(capturedPayload!["p_amount"]).toBe(50050)
    expect(capturedPayload!["p_utr"]).toBe("UTR20261031TEST")
    expect(capturedPayload!["p_payment_method"]).toBe("IMPS")
    expect(capturedPayload!["p_community_id"]).toBe("comm-fin-123")
  })

  it("gracefully displays server rejection when uncommitted balance is exceeded", async () => {
    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/admin_record_manual_payout`, () => {
        return HttpResponse.json({
          ok: false,
          error: "insufficient_uncommitted_balance",
          message: "Requested payout amount exceeds available uncommitted wallet balance. In-flight pending and disputed payouts are reserved.",
        })
      })
    )

    const user = userEvent.setup()
    render(
      <ManualPayoutModal
        isOpen={true}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
        community={stableCommunity}
        events={stableEvents}
        eventSummaries={stableSummaries}
        beneficiary={stableBeneficiary}
      />
    )

    const amountInput = screen.getByPlaceholderText("0.00")
    await user.clear(amountInput)
    await user.type(amountInput, "900")

    const utrInput = screen.getByPlaceholderText("e.g. UTR1234567890")
    await user.type(utrInput, "UTR_OVER_ALLOCATION")

    const submitBtn = screen.getByRole("button", { name: /Record Payout & Notify Organizer/i })
    await user.click(submitBtn)

    expect(await screen.findByText(/Requested payout amount exceeds available uncommitted wallet balance/i)).toBeInTheDocument()
    expect(mockOnSuccess).not.toHaveBeenCalled()
  })

  it("prevents double-submission by disabling commit button while in-flight", async () => {
    let resolveRpc: (val: unknown) => void
    const rpcPromise = new Promise((resolve) => {
      resolveRpc = resolve
    })

    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/admin_record_manual_payout`, async () => {
        await rpcPromise
        return HttpResponse.json({ ok: true, payout_id: "payout_slow_123" })
      })
    )

    const user = userEvent.setup()
    render(
      <ManualPayoutModal
        isOpen={true}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
        community={stableCommunity}
        events={stableEvents}
        eventSummaries={stableSummaries}
        beneficiary={stableBeneficiary}
      />
    )

    const amountInput = screen.getByPlaceholderText("0.00")
    await user.clear(amountInput)
    await user.type(amountInput, "300")

    const utrInput = screen.getByPlaceholderText("e.g. UTR1234567890")
    await user.type(utrInput, "UTR_DEBOUNCE_TEST")

    const submitBtn = screen.getByRole("button", { name: /Record Payout & Notify Organizer/i })
    await user.click(submitBtn)

    // Button should show loading spinner and be disabled during in-flight call
    expect(screen.getByRole("button", { name: /Recording Payout\.\.\./i })).toBeDisabled()

    // Complete the call
    resolveRpc!({ ok: true })

    await waitFor(() => {
      expect(mockOnSuccess).toHaveBeenCalled()
    })
  })
})
