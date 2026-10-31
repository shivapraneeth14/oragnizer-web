import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { AuthProvider, useAuth } from "./Auth"
import { supabase } from "./supabase"
import { server } from "./test/setup"
import { http, HttpResponse } from "msw"

const BASE_URL = "http://127.0.0.1:54321"

// Test harness component to interact with useAuth
function AuthTestConsumer() {
  const { user, isAdmin, loading, error, signIn, signOut } = useAuth()

  return (
    <div>
      <div data-testid="loading">{loading ? "loading" : "idle"}</div>
      <div data-testid="user">{user ? user.email : "no-user"}</div>
      <div data-testid="is-admin">{isAdmin ? "admin" : "not-admin"}</div>
      <div data-testid="error">{error || "no-error"}</div>

      <button
        onClick={() => signIn("admin@cluvo.com", "CorrectPassword123!")}
      >
        Sign In Admin
      </button>

      <button
        onClick={() => signIn("admin@cluvo.com", "WrongPassword!")}
      >
        Sign In Wrong Password
      </button>

      <button
        onClick={() => signIn("banned@cluvo.com", "AnyPassword123!")}
      >
        Sign In Banned
      </button>

      <button
        onClick={() => signIn("member@cluvo.com", "MemberPassword123!")}
      >
        Sign In Member
      </button>

      <button onClick={() => signOut()}>Sign Out</button>
    </div>
  )
}

describe("AuthContext (Admin Web Authentication & RBAC Gate)", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    await supabase.auth.signOut()
  })

  it("successfully signs in verified admin and sets admin privileges", async () => {
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <AuthProvider>
          <AuthTestConsumer />
        </AuthProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle")
    })

    await user.click(screen.getByRole("button", { name: "Sign In Admin" }))

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("admin@cluvo.com")
      expect(screen.getByTestId("is-admin").textContent).toBe("admin")
      expect(screen.getByTestId("error").textContent).toBe("no-error")
    })
  })

  it("handles invalid login credentials with user-friendly error message", async () => {
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <AuthProvider>
          <AuthTestConsumer />
        </AuthProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle")
    })

    await user.click(screen.getByRole("button", { name: "Sign In Wrong Password" }))

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toBe("Invalid email or password. Please try again.")
      expect(screen.getByTestId("is-admin").textContent).toBe("not-admin")
    })
  })

  it("rejects suspended/banned users with suspension notice", async () => {
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <AuthProvider>
          <AuthTestConsumer />
        </AuthProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle")
    })

    await user.click(screen.getByRole("button", { name: "Sign In Banned" }))

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toBe(
        "This account has been suspended. Please contact customer support."
      )
    })
  })

  it("blocks non-admin users even with valid Supabase auth tokens", async () => {
    const user = userEvent.setup()

    // Override is_admin_user RPC to return false
    server.use(
      http.post(`${BASE_URL}/rest/v1/rpc/is_admin_user`, () => {
        return HttpResponse.json(false)
      })
    )

    render(
      <MemoryRouter>
        <AuthProvider>
          <AuthTestConsumer />
        </AuthProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle")
    })

    await user.click(screen.getByRole("button", { name: "Sign In Member" }))

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toBe(
        "Access denied. This portal is for administrators only."
      )
      expect(screen.getByTestId("is-admin").textContent).toBe("not-admin")
      expect(screen.getByTestId("user").textContent).toBe("no-user")
    })
  })

  it("signs out and clears user and admin state", async () => {
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <AuthProvider>
          <AuthTestConsumer />
        </AuthProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle")
    })

    // First sign in admin
    await user.click(screen.getByRole("button", { name: "Sign In Admin" }))
    await waitFor(() => {
      expect(screen.getByTestId("is-admin").textContent).toBe("admin")
    })

    // Sign out
    await user.click(screen.getByRole("button", { name: "Sign Out" }))
    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("no-user")
      expect(screen.getByTestId("is-admin").textContent).toBe("not-admin")
    })
  })
})
