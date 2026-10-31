import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import ManualLookup from "./manual-lookup"
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
            profiles: [
              { first_name: "Bob", last_name: "Taylor", username: "bobt", email: "bob@example.com" },
            ],
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
})
