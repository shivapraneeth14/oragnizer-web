import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import ProtectedRoute from "./protected-route"
import * as supabaseFetch from "../supabase-fetch"

let mockSession: { access_token: string } | null = { access_token: "mock-valid-token" }
let mockLoading = false
const mockBlockSession = vi.fn().mockResolvedValue(undefined)

vi.mock("../auth-context", () => ({
  useAuth: () => ({
    session: mockSession,
    loading: mockLoading,
    blockSession: mockBlockSession,
  }),
}))

describe("ProtectedRoute (Organizer Web Auth & Role Gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession = { access_token: "mock-valid-token" }
    mockLoading = false
  })

  it("shows loading spinner when auth is loading or session is checking", () => {
    mockLoading = true
    const { container } = render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/" element={<div>Login Page</div>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <div>Secret Dashboard</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    )

    expect(container.querySelector("svg.animate-spin")).toBeInTheDocument()
    expect(screen.queryByText("Secret Dashboard")).not.toBeInTheDocument()
  })

  it("redirects unauthenticated users to the login route", async () => {
    mockSession = null
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/" element={<div>Login Page</div>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <div>Secret Dashboard</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText("Login Page")).toBeInTheDocument()
      expect(screen.queryByText("Secret Dashboard")).not.toBeInTheDocument()
    })
  })

  it("renders children when organizer session check succeeds", async () => {
    vi.spyOn(supabaseFetch, "checkOrganizerSession").mockResolvedValue({
      ok: true,
      organizer: true,
      networkError: false,
      deletionGrace: false,
      message: "Verified organizer",
      error: null,
    })

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/" element={<div>Login Page</div>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <div>Secret Dashboard</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText("Secret Dashboard")).toBeInTheDocument()
    })
  })

  it("displays deletion grace modal when account is scheduled for deletion", async () => {
    vi.spyOn(supabaseFetch, "checkOrganizerSession").mockResolvedValue({
      ok: false,
      organizer: false,
      networkError: false,
      deletionGrace: true,
      message: "Account in deletion grace",
      error: null,
    })

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/" element={<div>Login Page</div>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <div>Secret Dashboard</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText("Your account is scheduled for deletion")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: /Keep my account/i })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: /Sign out/i })).toBeInTheDocument()
      expect(screen.queryByText("Secret Dashboard")).not.toBeInTheDocument()
    })
  })

  it("displays network retry screen on transient network error and allows retrying", async () => {
    const user = userEvent.setup()
    const checkSpy = vi.spyOn(supabaseFetch, "checkOrganizerSession")
      .mockResolvedValueOnce({
        ok: false,
        organizer: false,
        networkError: true,
        message: "Network failure",
        error: "Unable to reach Cluvo auth services. Please check connection.",
      })
      .mockResolvedValueOnce({
        ok: true,
        organizer: true,
        networkError: false,
        deletionGrace: false,
        message: "Verified organizer",
        error: null,
      })

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/" element={<div>Login Page</div>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <div>Secret Dashboard</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    )

    // Verify error state
    await waitFor(() => {
      expect(
        screen.getByText("Unable to reach Cluvo auth services. Please check connection.")
      ).toBeInTheDocument()
    })

    // Click "Try again"
    const retryBtn = screen.getByRole("button", { name: /Try again/i })
    await user.click(retryBtn)

    // Now succeeds
    await waitFor(() => {
      expect(screen.getByText("Secret Dashboard")).toBeInTheDocument()
    })
    expect(checkSpy).toHaveBeenCalledTimes(2)
  })

  it("blocks session and redirects when user is not an organizer", async () => {
    vi.spyOn(supabaseFetch, "checkOrganizerSession").mockResolvedValue({
      ok: true,
      organizer: false,
      networkError: false,
      deletionGrace: false,
      message: "User does not have an active organizer role.",
      error: null,
    })

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/" element={<div>Login Page</div>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <div>Secret Dashboard</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(mockBlockSession).toHaveBeenCalledWith("User does not have an active organizer role.")
      expect(screen.getByText("Login Page")).toBeInTheDocument()
      expect(screen.queryByText("Secret Dashboard")).not.toBeInTheDocument()
    })
  })
})
