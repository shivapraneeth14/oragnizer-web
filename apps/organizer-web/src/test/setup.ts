import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, vi } from "vitest"
import { handlers } from "./mocks/handlers"

export const server = setupServer(...handlers)

beforeAll(() => {
  // Enforce strict network boundary: block all unexpected external requests
  server.listen({ onUnhandledRequest: "error" })
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
  vi.clearAllMocks()
})

afterAll(() => {
  server.close()
})

// Polyfill window.matchMedia for responsive hook testing
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Polyfill ResizeObserver
window.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

// Polyfill URL.createObjectURL and revokeObjectURL
if (typeof URL.createObjectURL === "undefined") {
  URL.createObjectURL = vi.fn(() => "blob:http://localhost:3000/mock-blob")
  URL.revokeObjectURL = vi.fn()
}

// Mock window.alert and window.confirm
window.alert = vi.fn()
window.confirm = vi.fn(() => true)
