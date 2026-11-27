import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import ManualLookup from "./manual-lookup"
import EventSelector from "./event-selector"
import CheckInList from "./check-in-list"
import ScanModal from "./scan-modal"
import { server } from "../../test/setup"
import { http, HttpResponse } from "msw"

const BASE_URL = "http://127.0.0.1:54321"

const mockStart = vi.fn().mockResolvedValue(undefined)
const mockStop = vi.fn().mockResolvedValue(undefined)

// Mock html5-qrcode
vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class {
    static getCameras = vi.fn().mockResolvedValue([{ id: "cam-1", label: "Camera 1" }])
    start = mockStart
    stop = mockStop
    clear = vi.fn()
  },
}))

vi.mock("../../lib/organizer-contacts", () => ({
  fetchOrganizerContacts: vi.fn().mockResolvedValue(
    new Map([["user-1", { email: "bob@example.com", phone: "+919876543210" }]])
  ),
}))

describe("CheckIn (Attendee Verification & Ticket Check-In)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("searches attendees by query and triggers check-in for confirmed registration", async () => {
    const user = userEvent.setup()
    const mockOnCheckIn = vi.fn()

    server.use(
      http.get(`${BASE_URL}/rest/v1/registrations`, () => {
        return HttpResponse.json([
          {
            id: "reg-attendee-1",
            user_id: "user-1",
            status: "confirmed",
            qr_code: "QR_TOKEN_BOB_123",
            profiles: { first_name: "Bob", last_name: "Taylor", username: "bobt", email: "bob@example.com" },
            events: {
              community_id: "comm_mock_123",
              status: "published",
              start_date: new Date(Date.now() + 86400000).toISOString(),
              end_date: new Date(Date.now() + 90000000).toISOString(),
            },
          },
        ])
      })
    )

    render(
      <ManualLookup
        eventId="event_mock_123"
        communityId="comm_mock_123"
        onCheckIn={mockOnCheckIn}
      />
    )

    const searchInput = screen.getByPlaceholderText(/Search by name, email, or booking ID/i)
    await user.type(searchInput, "Bob")

    const searchBtn = screen.getByRole("button", { name: "Search" })
    await user.click(searchBtn)

    // Attendee record should appear in results
    await waitFor(() => {
      expect(screen.getByText("Bob Taylor")).toBeInTheDocument()
      expect(screen.getByText("bob@example.com")).toBeInTheDocument()
      expect(screen.queryByText("Unknown")).not.toBeInTheDocument()
    })

    // Click Check In button
    const checkInBtn = screen.getByRole("button", { name: "Check In" })
    await user.click(checkInBtn)

    expect(mockOnCheckIn).toHaveBeenCalledWith("QR_TOKEN_BOB_123")
  })

  it("ScanModal provides manual entry fallback when camera access fails", async () => {
    const user = userEvent.setup()
    const mockOnScan = vi.fn()
    const mockOnClose = vi.fn()

    // Mock start to fail with Camera Permission error
    mockStart.mockRejectedValueOnce(new Error("Camera Permission denied"))

    render(
      <ScanModal
        open={true}
        onClose={mockOnClose}
        onScan={mockOnScan}
      />
    )

    // Should automatically switch to manual entry mode
    await waitFor(() => {
      expect(screen.getByText(/Enter the QR code value manually/i)).toBeInTheDocument()
    })

    // Enter manual code
    const input = screen.getByPlaceholderText(/QR code value\.\.\./i)
    await user.type(input, "QR_TOKEN_MANUAL_456")

    const submitBtn = screen.getByRole("button", { name: /Check In/i })
    await user.click(submitBtn)

    expect(mockOnScan).toHaveBeenCalledWith("QR_TOKEN_MANUAL_456")
  })

  it("handles duplicate check-in edge function response cleanly", async () => {
    let checkInError: string | null = null

    // Call check-in endpoint with duplicate qr code
    const res = await fetch(`${BASE_URL}/functions/v1/check-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qr_code: "ALREADY_CHECKED_IN" }),
    })

    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toBe("Attendee already checked in")
    expect(body.attendee_name).toBe("Jane Doe")
  })

  it("excludes closed events from the selector options and counts", async () => {
    const future = new Date(Date.now() + 86400000).toISOString()
    const past = new Date(Date.now() - 86400000).toISOString()

    server.use(
      http.get(`${BASE_URL}/rest/v1/events`, () => {
        return HttpResponse.json([
          { id: "open-event", title: "Open Workshop", status: "published", start_date: future, end_date: future },
          { id: "completed-event", title: "Completed Workshop", status: "completed", start_date: past, end_date: past },
          { id: "elapsed-event", title: "Elapsed Workshop", status: "published", start_date: past, end_date: past },
        ])
      }),
      http.get(`${BASE_URL}/rest/v1/registrations`, () => {
        return HttpResponse.json([
          { event_id: "open-event", checked_in: true },
          { event_id: "open-event", checked_in: false },
          { event_id: "completed-event", checked_in: false },
          { event_id: "elapsed-event", checked_in: false },
        ])
      })
    )

    const onEventsLoad = vi.fn()
    render(
      <EventSelector
        selectedEventId={null}
        onSelect={vi.fn()}
        communityId="comm_mock_123"
        onEventsLoad={onEventsLoad}
      />
    )

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "All Events (1/2)" })).toBeInTheDocument()
    })
    expect(screen.getAllByRole("option").map(o => o.textContent)).toEqual([
      "All Events (1/2)",
      "Open Workshop (1/2)",
    ])
    expect(onEventsLoad).toHaveBeenCalledWith([
      expect.objectContaining({ id: "open-event", total: 2, checked_in: 1 }),
    ])
  })

  it("hides closed events from the check-in records list", async () => {
    const future = new Date(Date.now() + 86400000).toISOString()
    const past = new Date(Date.now() - 86400000).toISOString()

    server.use(
      http.get(`${BASE_URL}/rest/v1/registrations`, () => {
        return HttpResponse.json([
          {
            id: "reg-open",
            status: "attended",
            checked_in_at: future,
            profiles: { first_name: "Alice", last_name: "Active" },
            events: { title: "Open Workshop", status: "published", start_date: future, end_date: future },
          },
          {
            id: "reg-closed",
            status: "attended",
            checked_in_at: past,
            profiles: { first_name: "Bob", last_name: "Closed" },
            events: { title: "Completed Workshop", status: "completed", start_date: past, end_date: past },
          },
        ])
      })
    )

    render(<CheckInList eventId={null} communityId="comm_mock_123" refreshKey={0} />)

    await waitFor(() => {
      expect(screen.getByText("Check-in Records (1/1)")).toBeInTheDocument()
    })
    expect(screen.getByText("Alice Active")).toBeInTheDocument()
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument()
    expect(screen.queryByText("Bob Closed")).not.toBeInTheDocument()
  })

  it("still shows names when the joined profile and event come back as arrays", async () => {
    const future = new Date(Date.now() + 86400000).toISOString()

    server.use(
      http.get(`${BASE_URL}/rest/v1/registrations`, () => {
        return HttpResponse.json([
          {
            id: "reg-array",
            status: "attended",
            checked_in_at: future,
            profiles: [{ first_name: "Dana", last_name: "Array" }],
            events: [{ title: "Array Workshop", status: "published", start_date: future, end_date: future }],
          },
        ])
      })
    )

    render(<CheckInList eventId={null} communityId="comm_mock_123" refreshKey={0} />)

    await waitFor(() => {
      expect(screen.getByText("Dana Array")).toBeInTheDocument()
    })
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument()
  })

  it("does not offer manual check-in for attendees of closed events", async () => {
    const user = userEvent.setup()
    const past = new Date(Date.now() - 86400000).toISOString()

    server.use(
      http.get(`${BASE_URL}/rest/v1/registrations`, () => {
        return HttpResponse.json([
          {
            id: "reg-closed",
            user_id: "user-2",
            status: "confirmed",
            qr_code: "QR_CLOSED",
            profiles: { first_name: "Carol", last_name: "Closed", username: "carolc" },
            events: { community_id: "comm_mock_123", status: "completed", start_date: past, end_date: past },
          },
        ])
      })
    )

    render(
      <ManualLookup eventId={null} communityId="comm_mock_123" onCheckIn={vi.fn()} />
    )

    await user.type(screen.getByPlaceholderText(/Search by name, email, or booking ID/i), "Carol")
    await user.click(screen.getByRole("button", { name: "Search" }))

    await waitFor(() => {
      expect(screen.getByText("No registrations found")).toBeInTheDocument()
    })
    expect(screen.queryByText("Carol Closed")).not.toBeInTheDocument()
  })
})
