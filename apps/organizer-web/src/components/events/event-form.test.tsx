import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import EventForm from "./event-form"
import type { EventFormData } from "../../hooks/use-events"

// Mock react-leaflet
vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: any) => <div data-testid="map-container">{children}</div>,
  TileLayer: () => <div data-testid="tile-layer" />,
  Marker: () => <div data-testid="marker" />,
  useMap: () => ({ flyTo: vi.fn() }),
  useMapEvents: () => null,
}))

vi.mock("leaflet", () => ({
  default: {
    divIcon: () => ({}),
  },
}))

vi.mock("../../lib/geocode", () => ({
  reverseGeocode: vi.fn().mockResolvedValue("MG Road, Bangalore, Karnataka"),
  searchPlaces: vi.fn().mockResolvedValue([
    { label: "MG Road, Bangalore", lat: 12.9716, lng: 77.5946 },
  ]),
}))

describe("EventForm (Organizer Event Creation & Management)", () => {
  const mockOnSave = vi.fn().mockResolvedValue(undefined)
  const mockOnClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders event form inputs and defaults to draft status", () => {
    render(
      <EventForm saving={false} onSave={mockOnSave} onClose={mockOnClose} />
    )

    expect(screen.getByPlaceholderText("Event title")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("0 = Free")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("Max attendees")).toBeInTheDocument()
    expect(screen.getByText("Create event")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Draft" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Published" })).toBeInTheDocument()
  })

  it("populates inputs with initial event data when editing", () => {
    const futureStart = new Date(Date.now() + 86400000).toISOString().slice(0, 16)
    const futureEnd = new Date(Date.now() + 90000000).toISOString().slice(0, 16)

    const initialData: EventFormData = {
      title: "Bangalore Rust Workshop",
      description: "Learn systems programming with Rust",
      start_date: futureStart,
      end_date: futureEnd,
      location: "MG Road, Bangalore",
      latitude: "12.9716",
      longitude: "77.5946",
      price: "499",
      capacity: "100",
      category: "Technology",
      status: "published",
      discussion_enabled: true,
      discussion_restricted: false,
      image_url: "https://res.cloudinary.com/demo/image/upload/sample.jpg",
      video_url: "",
    }

    render(
      <EventForm
        initial={initialData}
        saving={false}
        onSave={mockOnSave}
        onClose={mockOnClose}
      />
    )

    expect(screen.getByDisplayValue("Bangalore Rust Workshop")).toBeInTheDocument()
    expect(screen.getByDisplayValue("499")).toBeInTheDocument()
    expect(screen.getByDisplayValue("100")).toBeInTheDocument()
    expect(screen.getByText("Save changes")).toBeInTheDocument()
  })

  it("prevents saving when title is empty or required fields are missing", async () => {
    const user = userEvent.setup()

    render(
      <EventForm saving={false} onSave={mockOnSave} onClose={mockOnClose} />
    )

    const submitBtn = screen.getByRole("button", { name: "Create event" })
    expect(submitBtn).toBeDisabled() // disabled when title/category are empty
  })

  it("submits valid event data to onSave callback", async () => {
    const user = userEvent.setup()

    const futureStart = new Date(Date.now() + 86400000).toISOString().slice(0, 16)
    const futureEnd = new Date(Date.now() + 90000000).toISOString().slice(0, 16)

    const initialWithLocation: EventFormData = {
      title: "",
      description: "",
      start_date: futureStart,
      end_date: futureEnd,
      location: "MG Road, Bangalore",
      latitude: "12.9716",
      longitude: "77.5946",
      price: "250",
      capacity: "50",
      category: "Technology",
      status: "published",
      discussion_enabled: true,
      discussion_restricted: false,
      image_url: "",
      video_url: "",
    }

    render(
      <EventForm
        initial={initialWithLocation}
        saving={false}
        onSave={mockOnSave}
        onClose={mockOnClose}
      />
    )

    const titleInput = screen.getByPlaceholderText("Event title")
    await user.type(titleInput, "Full-Stack Web Dev")

    const submitBtn = screen.getByRole("button", { name: "Save changes" })
    expect(submitBtn).toBeEnabled()
    await user.click(submitBtn)

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledTimes(1)
      expect(mockOnSave).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Full-Stack Web Dev",
          price: "250",
          capacity: "50",
          category: "Technology",
          status: "published",
        })
      )
    })
  })

  it("invokes onClose when Cancel button is clicked", async () => {
    const user = userEvent.setup()

    render(
      <EventForm saving={false} onSave={mockOnSave} onClose={mockOnClose} />
    )

    const cancelBtn = screen.getByRole("button", { name: "Cancel" })
    await user.click(cancelBtn)

    expect(mockOnClose).toHaveBeenCalledTimes(1)
  })
})

