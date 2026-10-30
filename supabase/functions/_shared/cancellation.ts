// ============================================================================
// CLUVO — Shared Types & Helpers for Durable Event Cancellation & Bulk Refunds
// ============================================================================

export type TaskStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "uncertain"
  | "manual_review"
  | "skipped_attended"

export type JobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "requires_manual_review"

export type AdminResolutionType =
  | "adopt_provider_refund"
  | "retry_task"
  | "manual_settlement"

export interface CancellationJob {
  id: string
  event_id: string
  initiated_by: string
  status: JobStatus
  total_registrations: number
  total_refunds_eligible: number
  refunds_succeeded: number
  refunds_failed: number
  refunds_uncertain: number
  refunds_skipped_attended: number
  registrations_cancelled: number
  error_summary?: Record<string, unknown> | null
  started_at?: string | null
  completed_at?: string | null
  created_at: string
  updated_at: string
}

export interface RefundTask {
  id: string
  job_id: string
  event_id: string
  payment_id?: string | null
  registration_id: string
  amount: number
  task_type: "refund" | "cancel_only"
  status: TaskStatus
  attempt_count: number
  max_attempts: number
  next_attempt_at: string
  leased_at?: string | null
  leased_by?: string | null
  lease_expires_at?: string | null
  error_message?: string | null
  error_details?: Record<string, unknown> | null
  razorpay_refund_id?: string | null
  created_at: string
  updated_at: string
}

export function isTerminalTaskStatus(status: string): boolean {
  return status === "completed" || status === "skipped_attended"
}

export function isTerminalJobStatus(status: string): boolean {
  return status === "completed"
}

/**
 * Calculates exponential backoff with full randomized jitter for task retries.
 * Returns delay in milliseconds, bounded between 5s and 300s.
 */
export function calculateTaskBackoff(attempt: number): number {
  const baseDelay = Math.min(300, Math.pow(2, Math.max(attempt - 1, 0)) * 5) * 1000
  const jitter = Math.random() * 2000 // 0 - 2000ms jitter
  return baseDelay + jitter
}

