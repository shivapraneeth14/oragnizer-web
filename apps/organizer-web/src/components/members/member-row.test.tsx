import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import MemberRow from "./member-row"

interface TestMember {
  user_id: string
  role: string
  joined_at: string
  email: string | null
  username: string | null
  first_name: string | null
  last_name: string | null
}

const baseMember: TestMember = {
  user_id: "user-1",
  role: "MEMBER",
  joined_at: "2026-01-15T00:00:00Z",
  email: "bunny@example.com",
  username: null,
  first_name: null,
  last_name: null,
}

function renderRow(member: Partial<TestMember>, card = false) {
  const props = {
    member: { ...baseMember, ...member },
    currentUserId: "owner-1",
    communityId: "community-1",
    onRemoved: vi.fn(),
    card,
  }
  return card ? render(<MemberRow {...props} />) : render(<table><tbody><MemberRow {...props} /></tbody></table>)
}

describe("MemberRow display name", () => {
  it("prefers the username handle over the real name", () => {
    renderRow({ username: "shiva", first_name: "Kandala", last_name: "Shiva" })

    expect(screen.getByText("@shiva")).toBeInTheDocument()
    expect(screen.queryByText("Kandala Shiva")).not.toBeInTheDocument()
    expect(screen.getByText("S")).toBeInTheDocument()
  })

  it("uses first and last name when there is no username", () => {
    renderRow({ first_name: "Bunny", last_name: "K" })

    expect(screen.getByText("Bunny K")).toBeInTheDocument()
    expect(screen.getByText("B")).toBeInTheDocument()
  })

  it("shows Unknown when there is no username or name, ignoring email", () => {
    renderRow({ email: "bunny@example.com" })

    expect(screen.getByText("Unknown")).toBeInTheDocument()
    expect(screen.queryByText("bunny")).not.toBeInTheDocument()
    expect(screen.getByText("?")).toBeInTheDocument()
  })

  it("uses the same name in the mobile card", () => {
    renderRow({ first_name: "Kandala", last_name: "Shiva" }, true)

    expect(screen.getByText("Kandala Shiva")).toBeInTheDocument()
  })
})
