import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import type { Event } from "shared"
import EventDetail, { normalizePayment } from "./event-detail"
import { server } from "../../test/setup"

const BASE_URL = "http://127.0.0.1:54321"

const { mockFetchContacts } = vi.hoisted(() => ({ mockFetchContacts: vi.fn() }))
vi.mock("../../lib/organizer-contacts", () => ({ fetchOrganizerContacts: mockFetchContacts }))

const contacts = new Map([
  [
    "user-1",
    {
      id: "user-1",
      email: "bob@example.com",
      first_name: "Bob",
      last_name: "Taylor",
      username: null,
      avatar_url: null,
    },
  ],
])

const baseEvent: Event = {
  id: "event-1",
  community_id: "community-1",
  title: "Test Workshop",
  description: null,
  image_url: null,
  video_url: null,
  category: null,
  start_date: "2026-12-01T10:00:00Z",
  end_date: null,
  location: null,
  latitude: null,
  longitude: null,
  capacity: null,
  price: 50000,
  booked_count: 1,
  status: "published",
  created_by: "owner-1",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  deleted_at: null,
  discussion_enabled: false,
  discussion_restricted: false,
}

function mockRegistrations(price: number, payments: unknown) {
  server.use(
    http.get(`${BASE_URL}/rest/v1/registrations`, () =>
      HttpResponse.json([
        {
          id: "reg-1",
          user_id: "user-1",
          status: "confirmed",
          registered_at: "2026-11-20T10:00:00Z",
          profiles: { first_name: "Bob", last_name: "Taylor" },
          payments,
        },
      ]),
    ),
  )
  return { ...baseEvent, price }
}

function renderDetail(event: Event) {
  return render(
    <EventDetail
      event={event}
      onEdit={vi.fn()}
      onCancel={vi.fn()}
      onClose={vi.fn()}
    />,
  )
}

describe("EventDetail registrations", () => {
  beforeEach(() => {
    mockFetchContacts.mockResolvedValue(contacts)
  })

  it("normalizes an object-shaped payment (the real PostgREST response)", () => {
    expect(normalizePayment({ amount: 50000, organizer_share: 47000, status: "success" })).toEqual({
      amount: 50000,
      organizer_share: 47000,
      status: "success",
    })
    expect(normalizePayment([{ amount: 50000, organizer_share: 47000, status: "success" }])).toEqual({
      amount: 50000,
      organizer_share: 47000,
      status: "success",
    })
    expect(normalizePayment(null)).toBeNull()
  })

  it("shows email and payment when the API returns one payment as an object", async () => {
    const event = mockRegistrations(50000, { amount: 50000, organizer_share: 47000, status: "success" })
    renderDetail(event)

    await waitFor(() => expect(screen.getAllByText("Bob Taylor").length).toBeGreaterThan(0))
    const row = screen.getByRole("row", { name: /Bob Taylor/ })
    expect(within(row).getByText("bob@example.com")).toBeInTheDocument()
    expect(within(row).getByText("Success")).toBeInTheDocument()
    expect(within(row).getByText("₹500")).toBeInTheDocument()
  })

  it("shows Free for a free event instead of a blank payment", async () => {
    const event = mockRegistrations(0, null)
    renderDetail(event)

    await waitFor(() => expect(screen.getAllByText("Bob Taylor").length).toBeGreaterThan(0))
    const row = screen.getByRole("row", { name: /Bob Taylor/ })
    expect(within(row).getByText("Free")).toBeInTheDocument()
  })

  it("offers a retry when contact emails cannot be loaded", async () => {
    const user = userEvent.setup()
    mockFetchContacts.mockResolvedValueOnce(new Map())
    mockFetchContacts.mockResolvedValueOnce(contacts)
    const event = mockRegistrations(50000, { amount: 50000, organizer_share: 47000, status: "success" })
    renderDetail(event)

    const banner = await screen.findByText(/Couldn't load attendee emails/)
    expect(banner).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Retry" }))

    await waitFor(() => {
      const row = screen.getByRole("row", { name: /Bob Taylor/ })
      expect(within(row).getByText("bob@example.com")).toBeInTheDocument()
    })
    expect(screen.queryByText(/Couldn't load attendee emails/)).not.toBeInTheDocument()
  })
})
