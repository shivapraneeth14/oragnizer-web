import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import FinancialsPage from "./FinancialsPage"
import { server } from "../test/setup"
import { http, HttpResponse } from "msw"

const BASE_URL = "http://127.0.0.1:54321"

// Mock useAuth
vi.mock("../Auth", () => ({
  useAuth: () => ({
    user: { id: "admin-user-id", email: "admin@chigzo.com" },
  }),
}))

describe("FinancialsPage (Admin Financial Observability & Control)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders financial dashboard and loads community financial data", async () => {
    render(<FinancialsPage />)

    // Main heading after loading completes
    expect(await screen.findByText(/Financials & Event Passbook/i)).toBeInTheDocument()

    // Wait for communities to load in dropdown
    await waitFor(() => {
      expect(screen.getByText(/Admin Audit Community/i)).toBeInTheDocument()
    })

    // Check KPI cards render
    await waitFor(() => {
      expect(screen.getByText("Total Collected (incl. fee)")).toBeInTheDocument()
      expect(screen.getByText("Platform Fees (6%)")).toBeInTheDocument()
      expect(screen.getByText("Payouts Settled")).toBeInTheDocument()
    })
  })

  it("calculates and displays KPI values from transactions accurately", async () => {
    render(<FinancialsPage />)

    // Wait for statement data to be processed into KPIs
    // In our mock: ticket_sale gross 100000 paise (₹1,000.00), platform_fee 6000 paise (₹60.00), refund money_out 50000 paise (₹500.00)
    await waitFor(() => {
      expect(screen.getAllByText("₹1,000.00").length).toBeGreaterThan(0)
      expect(screen.getAllByText("₹60.00").length).toBeGreaterThan(0)
      expect(screen.getAllByText("₹500.00").length).toBeGreaterThan(0)
    })
  })

  it("filters ledger transactions by type", async () => {
    const user = userEvent.setup()
    render(<FinancialsPage />)

    // Wait for ledger table to load
    await waitFor(() => {
      expect(screen.getByText(/Consolidated Passbook Ledger/i)).toBeInTheDocument()
    })

    // Click "Refunds (Debits)" filter button
    const refundsFilterBtn = screen.getByRole("button", { name: /Refunds \(Debits\)/i })
    await user.click(refundsFilterBtn)

    // Should still display table with filtered rows
    await waitFor(() => {
      const rows = screen.getAllByRole("row")
      expect(rows.length).toBeGreaterThan(1)
    })
  })

  it("triggers financial reconciliation engine and displays summary", async () => {
    const user = userEvent.setup()
    render(<FinancialsPage />)

    // Click Reconciliation Audit button
    const reconBtn = await screen.findByRole("button", { name: /Reconciliation Audit/i })
    await user.click(reconBtn)

    // Check reconciliation panel opens and runs live 3-way balance audit
    await waitFor(() => {
      expect(screen.getByText(/3-Way Financial Reconciliation Engine/i)).toBeInTheDocument()
      expect(screen.getByText(/100% CLEAN/i)).toBeInTheDocument()
    })
  })

  it("opens manual payout modal with community details", async () => {
    const user = userEvent.setup()
    render(<FinancialsPage />)

    await waitFor(() => {
      expect(screen.getByText(/Admin Audit Community/i)).toBeInTheDocument()
    })

    const recordPayoutBtn = screen.getByRole("button", { name: /Record Manual Payout/i })
    await user.click(recordPayoutBtn)

    // ManualPayoutModal should open
    await waitFor(() => {
      expect(screen.getByText(/Record Manual Settlement \/ Payout/i)).toBeInTheDocument()
    })
  })

  it("does not count cancelled payouts into payoutsPending (VER-MS-003)", async () => {
    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/get_admin_financial_statement`, () => {
        return HttpResponse.json([
          {
            transaction_id: "tx-payout-cancelled",
            id: "tx-payout-cancelled",
            event_id: "event_mock_admin_1",
            event_title: "Admin Super Event",
            transaction_type: "payout_manual",
            money_in: 0,
            money_out: 25000,
            gross_amount: 0,
            platform_fee: 0,
            running_balance: 50000,
            balance_after: 50000,
            status: "cancelled",
            created_at: new Date().toISOString(),
          },
        ])
      })
    )

    render(<FinancialsPage />)

    // Wait for statement to load
    await waitFor(() => {
      expect(screen.getByText(/Financials & Event Passbook/i)).toBeInTheDocument()
    })

    // "locked" label should NOT be rendered when there are no pending or disputed payouts
    expect(screen.queryByText(/locked:/i)).not.toBeInTheDocument()
    // Should NOT display "+₹250.00 pending" anywhere
    expect(screen.queryByText(/\+₹250\.00 pending/i)).not.toBeInTheDocument()
  })
})
