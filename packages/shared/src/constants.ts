export const EVENT_STATUS = {
  DRAFT: "draft",
  PUBLISHED: "published",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
} as const

export const REGISTRATION_STATUS = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  ATTENDED: "attended",
} as const

export const PAYMENT_STATUS = {
  PENDING: "pending",
  SUCCESS: "success",
  FAILED: "failed",
  REFUNDED: "refunded",
} as const

export const COMMUNITY_STATUS = {
  PENDING_APPROVAL: "pending_approval",
  ACTIVE: "active",
  SUSPENDED: "suspended",
} as const

export const COMMUNITY_ROLES = {
  MEMBER: "MEMBER",
  MODERATOR: "MODERATOR",
  ORGANIZER: "ORGANIZER",
  OWNER: "OWNER",
} as const
