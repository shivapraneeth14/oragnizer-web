import { describe, it, expect } from "vitest"
import { isEventClosed, isCheckInEligible } from "./event-lifecycle"

const now = new Date("2026-06-15T12:00:00.000Z")

describe("event lifecycle", () => {
  it("treats completed and elapsed events as closed", () => {
    expect(isEventClosed({ status: "completed", start_date: "2026-07-01T00:00:00.000Z" }, now)).toBe(true)
    expect(isEventClosed({ status: "published", start_date: "2026-06-01T00:00:00.000Z", end_date: "2026-06-14T00:00:00.000Z" }, now)).toBe(true)
    expect(isEventClosed({ status: "published", start_date: "2026-06-01T00:00:00.000Z" }, now)).toBe(true)
  })

  it("keeps active, future and cancelled events check-in eligible", () => {
    expect(isCheckInEligible({ status: "published", start_date: "2026-06-15T11:00:00.000Z", end_date: "2026-06-15T13:00:00.000Z" }, now)).toBe(true)
    expect(isCheckInEligible({ status: "draft", start_date: "2026-07-01T00:00:00.000Z" }, now)).toBe(true)
    expect(isCheckInEligible({ status: "cancelled", start_date: "2026-01-01T00:00:00.000Z" }, now)).toBe(true)
    expect(isCheckInEligible({ status: "completed", start_date: "2026-01-01T00:00:00.000Z" }, now)).toBe(false)
    expect(isCheckInEligible({ status: "published", end_date: "2026-06-14T00:00:00.000Z" }, now)).toBe(false)
  })
})
