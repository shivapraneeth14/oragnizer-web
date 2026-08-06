export interface Profile {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  username: string | null
  avatar_url: string | null
  is_admin: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface Community {
  id: string
  name: string
  description: string | null
  location: string | null
  banner_url: string | null
  community_avatar_url: string | null
  owner_id: string
  visibility: "public" | "private"
  verification_status: "unverified" | "pending" | "verified"
  is_hidden: boolean
  member_count: number
  event_count: number
  category: string | null
  country: string | null
  state: string | null
  city: string | null
  contact_email: string | null
  contact_phone: string | null
  instagram_url: string | null
  facebook_url: string | null
  twitter_url: string | null
  linkedin_url: string | null
  tags: string[] | null
  rules: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface CommunityMember {
  community_id: string
  user_id: string
  role: "MEMBER" | "MODERATOR" | "ORGANIZER" | "OWNER"
  permissions: Record<string, boolean>
  joined_at: string
}

export interface JoinRequest {
  id: string
  community_id: string
  user_id: string
  status: "pending" | "approved" | "rejected"
  created_at: string
}

export interface Event {
  id: string
  community_id: string
  title: string
  description: string | null
  image_url: string | null
  start_date: string
  end_date: string | null
  location: string | null
  latitude: number | null
  longitude: number | null
  capacity: number | null
  price: number
  booked_count: number
  status: "draft" | "published" | "cancelled" | "completed"
  created_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
  discussion_enabled: boolean
  discussion_restricted: boolean
}

export interface WaitlistEntry {
  id: string
  event_id: string
  user_id: string
  position: number
  status: "waiting" | "promoted" | "expired"
  created_at: string
}

export interface Coupon {
  id: string
  community_id: string
  code: string
  discount_type: "percentage" | "flat"
  discount_value: number
  valid_until: string | null
  max_uses: number | null
  used_count: number
  created_at: string
}

export interface Registration {
  id: string
  event_id: string
  user_id: string
  status: "pending" | "confirmed" | "cancelled" | "attended"
  qr_code: string | null
  checked_in: boolean
  checked_in_at: string | null
  registered_at: string
  updated_at: string
  deleted_at: string | null
}

export interface Payment {
  id: string
  registration_id: string
  amount: number
  currency: string
  coupon_id: string | null
  razorpay_order_id: string | null
  razorpay_payment_id: string | null
  status: "pending" | "success" | "failed" | "refunded"
  refund_status: "requested" | "approved" | "processed" | "denied" | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface Plan {
  id: string
  name: string
  price: number
  limits: Record<string, number>
  created_at: string
}

export interface CommunitySubscription {
  id: string
  community_id: string
  plan_id: string
  status: "active" | "expired" | "cancelled"
  expires_at: string | null
  created_at: string
}

export interface Review {
  id: string
  event_id: string
  user_id: string
  rating: number
  comment: string | null
  created_at: string
  deleted_at: string | null
}

export interface Notification {
  id: string
  user_id: string
  type: string
  title: string
  body: string | null
  payload: Record<string, unknown> | null
  read: boolean
  created_at: string
}

export interface EventMessage {
  id: string
  event_id: string
  user_id: string
  content: string
  created_at: string
  updated_at: string
}

export interface EventRestrictedUser {
  id: string
  event_id: string
  user_id: string
  created_by: string
  created_at: string
}

export interface Report {
  id: string
  reporter_id: string
  target_type: "community" | "event" | "user" | "review"
  target_id: string
  reason: string | null
  status: "open" | "reviewed" | "resolved"
  created_at: string
}
