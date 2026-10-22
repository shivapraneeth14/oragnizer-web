export const GRACE_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

export function deletionDueAt(graceStartedAt: string): Date {
  return new Date(new Date(graceStartedAt).getTime() + GRACE_DAYS * DAY_MS)
}

export function daysRemaining(graceStartedAt: string, now: number = Date.now()): number {
  const due = deletionDueAt(graceStartedAt).getTime()
  return Math.max(0, Math.ceil((due - now) / DAY_MS))
}
