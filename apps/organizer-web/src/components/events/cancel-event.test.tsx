import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import CancelEventConfirmDialog from "./cancel-event-confirm-dialog"
import CancellationProgressModal from "./cancellation-progress-modal"
import type { Event } from "shared"
import { server } from "../../test/setup"
import { http, HttpResponse } from "msw"

const BASE_URL = "http://127.0.0.1:54321"

describe("CancelEvent (Cancellation & Refund Processing Guard)", () => {
  const mockOnClose = vi.fn()
  const mockOnCancelled = vi.fn()

  const sampleEvent: Event = {
    id: "event_mock_123",
    community_id: "comm_mock_123",
    title: "Bangalore React Summit",
    description: "Annual conference",
    image_url: null,
    video_url: null,
    category: "tech",
    latitude: 12.9352,
    longitude: 77.6245,
    price: 500,
    capacity: 100,
    booked_count: 5,
    status: "published",
    created_by: "user_mock_123",
    start_date: new Date(Date.now() + 86400000).toISOString(),
    end_date: new Date(Date.now() + 90000000).toISOString(),
    location: "Koramangala, Bangalore",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    discussion_enabled: true,
    discussion_restricted: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calculates eligible attendee refund totals before confirming cancellation", async () => {
    render(
      <CancelEventConfirmDialog
        event={sampleEvent}
        onClose={mockOnClose}
        onCancelled={mockOnCancelled}
      />
    )

    // Check dialog heading
    expect(screen.getByText(/Cancel Event/i)).toBeInTheDocument()

    // Wait for registration payment query to calculate refund total
    await waitFor(() => {
      expect(screen.getByText(/will be refunded to 1 attendee/i)).toBeInTheDocument()
    })
  })

  it("triggers cancel-event edge function and transitions to progress modal", async () => {
    const user = userEvent.setup()

    render(
      <CancelEventConfirmDialog
        event={sampleEvent}
        onClose={mockOnClose}
        onCancelled={mockOnCancelled}
      />
    )

    await waitFor(() => {
      expect(screen.getByText(/will be refunded to 1 attendee/i)).toBeInTheDocument()
    })

    const confirmBtn = screen.getByRole("button", { name: /Confirm Cancellation/i })
    await user.click(confirmBtn)

    // Progress modal should open and display the progress
    await waitFor(() => {
      expect(screen.getByText(/Cancelling Event/i)).toBeInTheDocument()
    })
  })

  it("CancellationProgressModal tracks progress and completes cancellation workflow", async () => {
    server.use(
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
      })
    )

    render(
      <CancellationProgressModal
        event={sampleEvent}
        jobId="job_cancel_mock_123"
        initialEligible={2}
        onClose={mockOnClose}
        onCompleted={mockOnCancelled}
      />
    )

    // Should indicate completed status
    await waitFor(() => {
      expect(screen.getByText("Completed")).toBeInTheDocument()
      expect(mockOnCancelled).toHaveBeenCalledTimes(1)
    })
  })
})
