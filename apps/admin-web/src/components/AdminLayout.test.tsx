import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import AdminLayout from "./AdminLayout"
import { server } from "../test/setup"
import { http, HttpResponse } from "msw"

const BASE_URL = "http://127.0.0.1:54321"

let mockAuthState = {
  user: { id: "admin-id", email: "admin@cluvo.com" } as any,
  session: { access_token: "mock-token" } as any,
  loading: false,
  isAdmin: true,
  signOut: vi.fn(),
}

vi.mock("../Auth", () => ({
  useAuth: () => mockAuthState,
}))

describe("AdminLayout (Admin Portal Shell & Route Guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAuthState = {
      user: { id: "admin-id", email: "admin@cluvo.com" },
      session: { access_token: "mock-token" },
      loading: false,
      isAdmin: true,
      signOut: vi.fn(),
    }

    // Default to desktop viewport (>= 1024px)
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("1024"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  })

  it("shows loading spinner when authentication is in progress", () => {
    mockAuthState.loading = true

    const { container } = render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/" element={<div>Login Page</div>} />
          <Route element={<AdminLayout />}>
            <Route path="/dashboard" element={<div>Admin Dashboard Content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    )

    expect(container.querySelector("svg.animate-spin")).toBeInTheDocument()
    expect(screen.queryByText("Admin Dashboard Content")).not.toBeInTheDocument()
  })

  it("redirects unauthenticated users to login route", async () => {
    mockAuthState.user = null
    mockAuthState.session = null
    mockAuthState.isAdmin = false

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/" element={<div>Login Page</div>} />
          <Route element={<AdminLayout />}>
            <Route path="/dashboard" element={<div>Admin Dashboard Content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText("Login Page")).toBeInTheDocument()
      expect(screen.queryByText("Admin Dashboard Content")).not.toBeInTheDocument()
    })
  })

  it("redirects non-admin authenticated users to login route", async () => {
    mockAuthState.isAdmin = false

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/" element={<div>Login Page</div>} />
          <Route element={<AdminLayout />}>
            <Route path="/dashboard" element={<div>Admin Dashboard Content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText("Login Page")).toBeInTheDocument()
      expect(screen.queryByText("Admin Dashboard Content")).not.toBeInTheDocument()
    })
  })

  it("renders navigation sidebar and active content for verified admin", async () => {
    server.use(
      http.head(`${BASE_URL}/rest/v1/admin_alerts`, () => {
        return new HttpResponse(null, {
          status: 200,
          headers: {
            "Content-Range": "0-1/2",
          },
        })
      })
    )

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/" element={<div>Login Page</div>} />
          <Route element={<AdminLayout />}>
            <Route path="/dashboard" element={<div>Admin Dashboard Content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    )

    // Check header brand and outlet content
    await waitFor(() => {
      expect(screen.getByText("CLUVO ADMIN")).toBeInTheDocument()
      expect(screen.getByText("Admin Dashboard Content")).toBeInTheDocument()
    })

    // Check main navigation links render
    expect(screen.getAllByText("Dashboard").length).toBeGreaterThan(0)
    expect(screen.getByText("Communities")).toBeInTheDocument()
    expect(screen.getByText("Users")).toBeInTheDocument()
    expect(screen.getByText("Events")).toBeInTheDocument()
    expect(screen.getByText("Financials & Ledger")).toBeInTheDocument()
    expect(screen.getByText("Alerts")).toBeInTheDocument()
    expect(screen.getByText("Reports")).toBeInTheDocument()
  })

  it("handles mobile layout with hamburger menu toggle", async () => {
    const user = userEvent.setup()

    // Mobile viewport
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))

    const { container } = render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/" element={<div>Login Page</div>} />
          <Route element={<AdminLayout />}>
            <Route path="/dashboard" element={<div>Admin Dashboard Content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText("Admin Dashboard Content")).toBeInTheDocument()
    })

    // On mobile initially sidebar is collapsed (CLUVO ADMIN brand not shown)
    expect(screen.queryByText("CLUVO ADMIN")).not.toBeInTheDocument()

    // Click mobile hamburger button in header
    const hamburgerBtn = container.querySelector("header button")!
    expect(hamburgerBtn).toBeInTheDocument()
    await user.click(hamburgerBtn)

    // Now sidebar is open on mobile
    await waitFor(() => {
      expect(screen.getByText("CLUVO ADMIN")).toBeInTheDocument()
    })
  })
})
