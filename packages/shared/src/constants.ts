export const EVENT_STATUS = {
  DRAFT: "draft",
  PUBLISHED: "published",
  CANCELLING: "cancelling",
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

/**
 * Columns on `communities` that a signed-in client may SELECT directly.
 *
 * Financial/payout columns (wallet_balance, cashfree_beneficiary_id,
 * razorpay_account_id, razorpay_account_status, platform_fee_amount) are
 * deliberately absent: they are readable only through the
 * `get_community_financials` RPC, which authorises owner/team/admin.
 *
 * Keep this list in sync with the GRANT in
 * supabase/migrations/202610270003_community_financial_column_grants.sql —
 * supabase/tests/community_financials.test.ts fails on drift.
 */
export const COMMUNITY_CLIENT_COLUMNS = [
  "id",
  "name",
  "description",
  "location",
  "banner_url",
  "community_avatar_url",
  "category",
  "city",
  "state",
  "country",
  "tags",
  "rules",
  "visibility",
  "instagram_url",
  "facebook_url",
  "twitter_url",
  "linkedin_url",
  "owner_id",
  "member_count",
  "event_count",
  "deleted_at",
  "is_hidden",
  "verification_status",
  "created_at",
  "updated_at",
  "contact_email",
  "contact_phone",
  "commission_percent",
  "commission_on",
  "deletion_grace_started_at",
  "is_hidden_before_deletion",
  "closed_at",
] as const

export const COMMUNITY_CLIENT_COLUMNS_SELECT = COMMUNITY_CLIENT_COLUMNS.join(",")
