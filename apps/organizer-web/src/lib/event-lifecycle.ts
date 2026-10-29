export type EventDisplayStatus = "draft" | "published" | "cancelled" | "closed"

export interface EventLike {
  status?: string | null
  start_date?: string | null
  end_date?: string | null
}

/**
 * Returns true if the event has ended and is now closed.
 * Matches Mobile lifecycle logic:
 * - Cancelled events are NOT closed (they are cancelled).
 * - Completed status is closed.
 * - If current time > end_date (or start_date if no end_date), the event is closed.
 */
export function isEventClosed(event: EventLike, now: Date = new Date()): boolean {
  if (event.status === "cancelled") return false
  if (event.status === "completed") return true

  const cutoff = event.end_date || event.start_date
  if (cutoff) {
    const cutoffMs = new Date(cutoff).getTime()
    if (!Number.isNaN(cutoffMs) && now.getTime() > cutoffMs) {
      return true
    }
  }
  return false
}

/**
 * Closed and cancelled events cannot be edited.
 */
export function canEditEvent(event: EventLike, now: Date = new Date()): boolean {
  if (event.status === "cancelled") return false
  if (isEventClosed(event, now)) return false
  return true
}

/**
 * Closed and cancelled events cannot be cancelled.
 */
export function canCancelEvent(event: EventLike, now: Date = new Date()): boolean {
  if (event.status === "cancelled") return false
  if (isEventClosed(event, now)) return false
  return true
}

/**
 * Returns the effective display status for UI badges and labels.
 */
export function getEventDisplayStatus(event: EventLike, now: Date = new Date()): EventDisplayStatus {
  if (event.status === "cancelled") return "cancelled"
  if (isEventClosed(event, now)) return "closed"
  if (event.status === "draft") return "draft"
  return "published"
}

export function getEventStatusLabel(status: EventDisplayStatus): string {
  switch (status) {
    case "closed":
      return "Closed"
    case "cancelled":
      return "Cancelled"
    case "published":
      return "Published"
    case "draft":
      return "Draft"
  }
}

export const eventStatusColors: Record<EventDisplayStatus, string> = {
  draft: "bg-neutral-100 text-neutral-600",
  published: "bg-green-100 text-green-700",
  cancelled: "bg-red-100 text-red-600",
  closed: "bg-neutral-100 text-neutral-600 border border-neutral-200",
}
