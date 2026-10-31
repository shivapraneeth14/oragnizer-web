import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import RefundManualReviewModal, { type RefundTaskItem } from "./RefundManualReviewModal"
import { server } from "../test/setup"
import { http, HttpResponse } from "msw"

const BASE_URL = "http://127.0.0.1:54321"

// Mock useAuth
const mockAdminUser = {
  id: "admin-auth-uuid-456",
  email: "admin@cluvo.com",
}

let currentUser: { id: string; email: string } | null = mockAdminUser

vi.mock("../Auth", () => ({
  useAuth: () => ({
    user: currentUser,
  }),
}))

describe("RefundManualReviewModal (Financial Recovery & Invariants)", () => {
  const mockOnClose = vi.fn()
  const mockOnResolved = vi.fn()

  const sampleTask: RefundTaskItem = {
    id: "task-refund-999",
    job_id: "job-cancel-111",
    event_id: "event-react-meetup",
    payment_id: "pay_RazorpayMock123",
    registration_id: "reg-user-456",
    amount: 50000, // 50,000 paise = ₹500.00
    task_type: "event_cancellation",
    status: "manual_review",
    attempt_count: 3,
    max_attempts: 5,
    error_message: "Razorpay 504 Gateway Timeout during refund creation",
    created_at: "2026-10-31T03:00:00.000Z",
    updated_at: "2026-10-31T03:15:00.000Z",
    user_email: "attendee@example.com",
    event_title: "React Workshop",
  }

  beforeEach(() => {
    vi.clearAllMocks()
    currentUser = mockAdminUser
  })

  it("returns null when isOpen is false or task is null", () => {
    const { container: closedContainer } = render(
      <RefundManualReviewModal
        isOpen={false}
        task={sampleTask}
        onClose={mockOnClose}
        onResolved={mockOnResolved}
      />
    )
    expect(closedContainer).toBeEmptyDOMElement()

    const { container: nullTaskContainer } = render(
      <RefundManualReviewModal
        isOpen={true}
        task={null}
        onClose={mockOnClose}
        onResolved={mockOnResolved}
      />
    )
    expect(nullTaskContainer).toBeEmptyDOMElement()
  })

  it("renders task snapshot with formatted currency, error, and status badge", () => {
    render(
      <RefundManualReviewModal
        isOpen={true}
        task={sampleTask}
        onClose={mockOnClose}
        onResolved={mockOnResolved}
      />
    )

    expect(screen.getByText("Manual Refund Resolution")).toBeInTheDocument()
    // ₹500.00 formatted
    expect(screen.getByText("₹500.00")).toBeInTheDocument()
    // Status
    expect(screen.getByText("manual review")).toBeInTheDocument()
    // Attempts
    expect(screen.getByText("3 / 5")).toBeInTheDocument()
    // Attendee
    expect(screen.getByText("attendee@example.com")).toBeInTheDocument()
    // Payment ID
    expect(screen.getByText("pay_RazorpayMock123")).toBeInTheDocument()
    // Error
    expect(screen.getByText(/Razorpay 504 Gateway Timeout/i)).toBeInTheDocument()
  })

  it("requires Razorpay Refund ID when adopting provider refund", async () => {
    const user = userEvent.setup()

    render(
      <RefundManualReviewModal
        isOpen={true}
        task={sampleTask}
        onClose={mockOnClose}
        onResolved={mockOnResolved}
      />
    )

    const form = screen.getByRole("button", { name: /Confirm & Resolve Task/i }).closest("form")!
    form.noValidate = true

    const refundIdInput = screen.getByPlaceholderText("e.g. rfnd_Nw3hU1B6t99eKl")
    expect(refundIdInput).toBeInTheDocument()

    // Leave input empty and submit
    await user.click(screen.getByRole("button", { name: /Confirm & Resolve Task/i }))

    expect(
      await screen.findByText(/A valid Razorpay Refund ID .* is required for adoption/i)
    ).toBeInTheDocument()
    expect(mockOnResolved).not.toHaveBeenCalled()
  })

  it("requires settlement notes when selecting manual offline settlement", async () => {
    const user = userEvent.setup()

    render(
      <RefundManualReviewModal
        isOpen={true}
        task={sampleTask}
        onClose={mockOnClose}
        onResolved={mockOnResolved}
      />
    )

    const form = screen.getByRole("button", { name: /Confirm & Resolve Task/i }).closest("form")!
    form.noValidate = true

    // Select Option 3: Manual Offline Settlement
    const manualRadio = screen.getByRole("radio", { name: /Record Offline \/ Direct Settlement/i })
    await user.click(manualRadio)

    const submitBtn = screen.getByRole("button", { name: /Confirm & Resolve Task/i })
    await user.click(submitBtn)

    expect(
      await screen.findByText(/Please specify settlement details .* for manual settlement/i)
    ).toBeInTheDocument()
    expect(mockOnResolved).not.toHaveBeenCalled()
  })

  it("successfully adopts provider refund with valid Razorpay Refund ID", async () => {
    const user = userEvent.setup()

    let capturedPayload: Record<string, unknown> | null = null
    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/admin_resolve_refund_task`, async ({ request }) => {
        capturedPayload = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, task_id: "task-refund-999" })
      })
    )

    render(
      <RefundManualReviewModal
        isOpen={true}
        task={sampleTask}
        onClose={mockOnClose}
        onResolved={mockOnResolved}
      />
    )

    const refundIdInput = screen.getByPlaceholderText("e.g. rfnd_Nw3hU1B6t99eKl")
    await user.type(refundIdInput, "rfnd_Success123456")

    const notesInput = screen.getByPlaceholderText(/Add context for internal financial audit log/i)
    await user.type(notesInput, "Verified in Razorpay dashboard")

    const submitBtn = screen.getByRole("button", { name: /Confirm & Resolve Task/i })
    await user.click(submitBtn)

    await waitFor(() => {
      expect(mockOnResolved).toHaveBeenCalledTimes(1)
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })

    expect(capturedPayload).toEqual({
      p_task_id: "task-refund-999",
      p_resolution_type: "adopt_provider_refund",
      p_admin_id: "admin-auth-uuid-456",
      p_razorpay_refund_id: "rfnd_Success123456",
      p_notes: "Verified in Razorpay dashboard",
    })
  })

  it("successfully re-queues task for worker retry", async () => {
    const user = userEvent.setup()

    let capturedPayload: Record<string, unknown> | null = null
    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/admin_resolve_refund_task`, async ({ request }) => {
        capturedPayload = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, task_id: "task-refund-999" })
      })
    )

    render(
      <RefundManualReviewModal
        isOpen={true}
        task={sampleTask}
        onClose={mockOnClose}
        onResolved={mockOnResolved}
      />
    )

    const retryRadio = screen.getByRole("radio", { name: /Re-queue Task for Background Worker/i })
    await user.click(retryRadio)

    const notesInput = screen.getByPlaceholderText(/Add context for internal financial audit log/i)
    await user.type(notesInput, "Rate limit issue resolved on gateway")

    const submitBtn = screen.getByRole("button", { name: /Confirm & Resolve Task/i })
    await user.click(submitBtn)

    await waitFor(() => {
      expect(mockOnResolved).toHaveBeenCalledTimes(1)
    })

    expect(capturedPayload).toEqual({
      p_task_id: "task-refund-999",
      p_resolution_type: "retry_task",
      p_admin_id: "admin-auth-uuid-456",
      p_razorpay_refund_id: null,
      p_notes: "Rate limit issue resolved on gateway",
    })
  })

  it("handles server RPC failure properly", async () => {
    const user = userEvent.setup()

    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/admin_resolve_refund_task`, () => {
        return HttpResponse.json({
          error: "Database constraint: task is already resolved by another admin.",
        })
      })
    )

    render(
      <RefundManualReviewModal
        isOpen={true}
        task={sampleTask}
        onClose={mockOnClose}
        onResolved={mockOnResolved}
      />
    )

    const refundIdInput = screen.getByPlaceholderText("e.g. rfnd_Nw3hU1B6t99eKl")
    await user.type(refundIdInput, "rfnd_Duplicate789")

    const submitBtn = screen.getByRole("button", { name: /Confirm & Resolve Task/i })
    await user.click(submitBtn)

    expect(
      await screen.findByText(/task is already resolved by another admin/i)
    ).toBeInTheDocument()
    expect(mockOnResolved).not.toHaveBeenCalled()
  })

  it("shows error when admin session is expired", async () => {
    const user = userEvent.setup()
    currentUser = null // Session expired

    render(
      <RefundManualReviewModal
        isOpen={true}
        task={sampleTask}
        onClose={mockOnClose}
        onResolved={mockOnResolved}
      />
    )

    const form = screen.getByRole("button", { name: /Confirm & Resolve Task/i }).closest("form")!
    form.noValidate = true

    const submitBtn = screen.getByRole("button", { name: /Confirm & Resolve Task/i })
    await user.click(submitBtn)

    expect(
      await screen.findByText(/Admin session expired\. Please refresh and log in\./i)
    ).toBeInTheDocument()
    expect(mockOnResolved).not.toHaveBeenCalled()
  })
})
