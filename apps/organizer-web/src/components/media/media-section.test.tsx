import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import MediaSection from "./media-section"
import { server } from "../../test/setup"
import { http, HttpResponse } from "msw"

const BASE_URL = "http://127.0.0.1:54321"

// Mock Cloudinary helpers
vi.mock("../../lib/cloudinary", () => ({
  uploadToCloudinary: vi.fn().mockResolvedValue("https://res.cloudinary.com/demo/image/upload/sample.jpg"),
  uploadVideoToCloudinary: vi.fn().mockResolvedValue("https://res.cloudinary.com/demo/video/upload/sample.mp4"),
  videoPosterUrl: vi.fn((url: string) => url.replace(".mp4", ".jpg")),
}))

vi.mock("../../hooks/use-events", () => ({
  useEvents: () => ({
    events: [
      { id: "event_mock_123", title: "Test Workshop" },
    ],
    loading: false,
  }),
}))

describe("MediaSection (Media Gallery & Asset Deletion Guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.confirm = vi.fn(() => true)
  })

  it("renders gallery header and loads community media items", async () => {
    server.use(
      http.get(`${BASE_URL}/rest/v1/media`, () => {
        return HttpResponse.json([
          {
            id: "media-img-1",
            mediable_type: "community",
            url: "https://res.cloudinary.com/demo/image/upload/v1/comm1.jpg",
            thumbnail_url: null,
            type: "image",
            sort_order: 1,
            caption: "Community Kickoff",
          },
        ])
      })
    )

    render(<MediaSection communityId="comm_mock_123" />)

    expect(screen.getByText("Media Gallery")).toBeInTheDocument()
    expect(screen.getByText(/Manage photos and videos for your community and events/i)).toBeInTheDocument()

    // Community media should load
    await waitFor(() => {
      expect(screen.getByAltText("Community Kickoff")).toBeInTheDocument()
    })
  })

  it("handles deletion of community gallery asset when confirmed", async () => {
    const user = userEvent.setup()
    let deleteCalled = false

    server.use(
      http.get(`${BASE_URL}/rest/v1/media`, () => {
        return HttpResponse.json([
          {
            id: "media-img-delete",
            mediable_type: "community",
            url: "https://res.cloudinary.com/demo/image/upload/v1/to_delete.jpg",
            thumbnail_url: null,
            type: "image",
            sort_order: 1,
            caption: "Obsolete Poster",
          },
        ])
      }),
      http.delete(`${BASE_URL}/rest/v1/media`, () => {
        deleteCalled = true
        return new HttpResponse(null, { status: 204 })
      })
    )

    render(<MediaSection communityId="comm_mock_123" />)

    await waitFor(() => {
      expect(screen.getByAltText("Obsolete Poster")).toBeInTheDocument()
    })

    const deleteBtn = screen.getByTitle("Delete")
    await user.click(deleteBtn)

    expect(window.confirm).toHaveBeenCalledWith("Delete this media?")
    await waitFor(() => {
      expect(deleteCalled).toBe(true)
    })
  })

  it("prevents deletion of active media assets via delete-media edge function (BUG-006 invariant)", async () => {
    // Direct call to delete-media edge function with active avatar/banner
    const res = await fetch(`${BASE_URL}/functions/v1/delete-media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_id: "active-avatar-id" }),
    })

    const body = await res.json()
    expect(res.status).toBe(403)
    expect(body.error).toBe("Cannot destroy active community asset")
  })
})
