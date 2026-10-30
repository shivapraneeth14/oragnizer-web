import { useState } from "react"
import { supabase } from "../supabase"
import { useAuth } from "../Auth"
import { formatCurrency, formatDateTime } from "./TransactionDetailDrawer"

export interface RefundTaskItem {
  id: string
  job_id: string
  event_id: string
  payment_id?: string | null
  registration_id: string
  amount: number
  task_type?: string
  status: string
  attempt_count: number
  max_attempts: number
  next_attempt_at?: string
  error_message?: string | null
  error_details?: Record<string, unknown> | null
  razorpay_refund_id?: string | null
  created_at: string
  updated_at: string
  user_email?: string
  event_title?: string
}

interface Props {
  isOpen: boolean
  task: RefundTaskItem | null
  onClose: () => void
  onResolved: () => void
}

type ResolutionType = "adopt_provider_refund" | "retry_task" | "manual_settlement"

export default function RefundManualReviewModal({
  isOpen,
  task,
  onClose,
  onResolved,
}: Props) {
  const { user } = useAuth()
  const [resolutionType, setResolutionType] = useState<ResolutionType>("adopt_provider_refund")
  const [razorpayRefundId, setRazorpayRefundId] = useState("")
  const [notes, setNotes] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  if (!isOpen || !task) return null

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1500)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user) {
      setError("Admin session expired. Please refresh and log in.")
      return
    }

    setError(null)
    setSubmitting(true)

    try {
      if (resolutionType === "adopt_provider_refund") {
        if (!razorpayRefundId.trim() || razorpayRefundId.trim().length < 5) {
          throw new Error("A valid Razorpay Refund ID (e.g. rfnd_XXXXXXXXXXXXXX) is required for adoption.")
        }
      } else if (resolutionType === "manual_settlement") {
        if (!notes.trim() || notes.trim().length < 5) {
          throw new Error("Please specify settlement details (e.g. UTR / IMPS reference and date) for manual settlement.")
        }
      }

      const { data, error: rpcError } = await supabase.rpc("admin_resolve_refund_task", {
        p_task_id: task.id,
        p_resolution_type: resolutionType,
        p_admin_id: user.id,
        p_razorpay_refund_id: resolutionType === "adopt_provider_refund" ? razorpayRefundId.trim() : null,
        p_notes: notes.trim() || null,
      })

      if (rpcError) throw rpcError
      if (data?.error) throw new Error(data.error)

      onResolved()
      onClose()
    } catch (err: any) {
      console.error("Resolution failed:", err)
      setError(err.message || "Failed to resolve refund task.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="relative w-full max-w-2xl rounded-2xl bg-white shadow-2xl overflow-hidden border border-neutral-200">
        {/* Header */}
        <div className="bg-neutral-900 px-6 py-4 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-500/20 text-rose-400 font-bold">
              ⚠️
            </span>
            <div>
              <h3 className="text-base font-bold text-white">Manual Refund Resolution</h3>
              <p className="text-xs text-neutral-400">
                Audited recovery workflow for unresolved refund queue task
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[80vh] overflow-y-auto">
          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 flex items-start gap-2">
              <span className="text-base leading-none">⚠️</span>
              <div className="flex-1 font-medium">{error}</div>
            </div>
          )}

          {/* Task Snapshot Card */}
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/70 p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-neutral-200/80 pb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-500">
                Task Snapshot
              </span>
              <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider ${
                task.status === "manual_review" ? "bg-rose-100 text-rose-800" :
                task.status === "uncertain" ? "bg-amber-100 text-amber-800" :
                task.status === "failed" ? "bg-red-100 text-red-800" :
                "bg-neutral-100 text-neutral-700"
              }`}>
                {task.status.replace("_", " ")}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
              <div>
                <span className="text-neutral-400 block">Refund Amount</span>
                <span className="text-base font-black text-rose-600">
                  {formatCurrency(task.amount)}
                </span>
              </div>
              <div>
                <span className="text-neutral-400 block">Attempts</span>
                <span className="font-semibold text-neutral-800">
                  {task.attempt_count} / {task.max_attempts}
                </span>
              </div>
              <div>
                <span className="text-neutral-400 block">Created At</span>
                <span className="font-medium text-neutral-700">
                  {formatDateTime(task.created_at)}
                </span>
              </div>
              <div className="col-span-2">
                <span className="text-neutral-400 block">Attendee / User</span>
                <span className="font-semibold text-neutral-800 truncate block">
                  {task.user_email || task.registration_id}
                </span>
              </div>
              <div>
                <span className="text-neutral-400 block">Task ID</span>
                <div className="flex items-center gap-1 font-mono text-[11px] text-neutral-600">
                  <span className="truncate max-w-[100px]">{task.id}</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(task.id, "task_id")}
                    className="text-neutral-400 hover:text-neutral-700"
                    title="Copy Task ID"
                  >
                    {copiedKey === "task_id" ? "✓" : "📋"}
                  </button>
                </div>
              </div>
            </div>

            {task.payment_id && (
              <div className="text-xs pt-1 border-t border-neutral-200/50 flex items-center justify-between">
                <span className="text-neutral-500">Payment ID:</span>
                <span className="font-mono text-neutral-700 font-semibold">{task.payment_id}</span>
              </div>
            )}

            {task.error_message && (
              <div className="rounded-lg bg-rose-50 border border-rose-100 p-2.5 text-xs text-rose-900">
                <span className="font-bold block text-rose-950 mb-0.5">Last Provider / Engine Error:</span>
                <span className="font-mono text-[11px] break-all">{task.error_message}</span>
              </div>
            )}
          </div>

          {/* Action Choice Radio Grid */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-neutral-600 mb-2">
              Select Resolution Action
            </label>
            <div className="grid grid-cols-1 gap-2.5">
              {/* Option 1: Adopt Provider Refund */}
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-all ${
                  resolutionType === "adopt_provider_refund"
                    ? "border-cluvo-primary bg-pink-50/40 ring-1 ring-cluvo-primary"
                    : "border-neutral-200 bg-white hover:bg-neutral-50"
                }`}
              >
                <input
                  type="radio"
                  name="resolution"
                  value="adopt_provider_refund"
                  checked={resolutionType === "adopt_provider_refund"}
                  onChange={() => setResolutionType("adopt_provider_refund")}
                  className="mt-1 h-4 w-4 text-cluvo-primary focus:ring-cluvo-primary"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-neutral-900">
                      1. Adopt Provider Refund (Reconciliation)
                    </span>
                    <span className="rounded bg-emerald-100 px-1.5 py-0.2 text-[10px] font-bold text-emerald-800">
                      Recommended for 409 / Timeouts
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    Use when you verified in the Razorpay Dashboard that the refund actually succeeded. Adopts the existing Razorpay refund without issuing duplicate money.
                  </p>
                </div>
              </label>

              {/* Option 2: Retry Task */}
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-all ${
                  resolutionType === "retry_task"
                    ? "border-cluvo-primary bg-pink-50/40 ring-1 ring-cluvo-primary"
                    : "border-neutral-200 bg-white hover:bg-neutral-50"
                }`}
              >
                <input
                  type="radio"
                  name="resolution"
                  value="retry_task"
                  checked={resolutionType === "retry_task"}
                  onChange={() => setResolutionType("retry_task")}
                  className="mt-1 h-4 w-4 text-cluvo-primary focus:ring-cluvo-primary"
                />
                <div className="flex-1">
                  <span className="text-xs font-bold text-neutral-900">
                    2. Re-queue Task for Background Worker
                  </span>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    Reset attempts to 0 and re-enable automatic worker processing with the same idempotency key (e.g. after resolving transient network or account limits).
                  </p>
                </div>
              </label>

              {/* Option 3: Manual Offline Settlement */}
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-all ${
                  resolutionType === "manual_settlement"
                    ? "border-cluvo-primary bg-pink-50/40 ring-1 ring-cluvo-primary"
                    : "border-neutral-200 bg-white hover:bg-neutral-50"
                }`}
              >
                <input
                  type="radio"
                  name="resolution"
                  value="manual_settlement"
                  checked={resolutionType === "manual_settlement"}
                  onChange={() => setResolutionType("manual_settlement")}
                  className="mt-1 h-4 w-4 text-cluvo-primary focus:ring-cluvo-primary"
                />
                <div className="flex-1">
                  <span className="text-xs font-bold text-neutral-900">
                    3. Record Offline / Direct Settlement
                  </span>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    Use when the refund was sent directly to the customer via IMPS/NEFT/UPI transfer outside of Razorpay. Requires an audited reference/UTR.
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* Conditional Inputs */}
          {resolutionType === "adopt_provider_refund" && (
            <div className="space-y-1.5 animate-in fade-in duration-150">
              <label className="block text-xs font-bold text-neutral-700">
                Razorpay Refund ID <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={razorpayRefundId}
                onChange={(e) => setRazorpayRefundId(e.target.value)}
                placeholder="e.g. rfnd_Nw3hU1B6t99eKl"
                className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-xs font-mono font-semibold text-neutral-900 focus:border-cluvo-primary focus:outline-none focus:ring-1 focus:ring-cluvo-primary"
                required
              />
              <p className="text-[11px] text-neutral-500">
                Copy the refund ID directly from the Razorpay Dashboard payment details.
              </p>
            </div>
          )}

          {resolutionType === "manual_settlement" && (
            <div className="space-y-1.5 animate-in fade-in duration-150">
              <label className="block text-xs font-bold text-neutral-700">
                Settlement Reference & Bank Details <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Direct IMPS UTR 429381028481 to HDFC Acct ending 4910 on 2026-10-31"
                className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-xs font-semibold text-neutral-900 focus:border-cluvo-primary focus:outline-none focus:ring-1 focus:ring-cluvo-primary"
                required
              />
              <p className="text-[11px] text-neutral-500">
                Document bank reference number, transfer mode, and recipient confirmation.
              </p>
            </div>
          )}

          {resolutionType !== "manual_settlement" && (
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-neutral-700">
                Audit Notes (Optional)
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Add context for internal financial audit log..."
                className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-xs text-neutral-900 focus:border-cluvo-primary focus:outline-none focus:ring-1 focus:ring-cluvo-primary"
              />
            </div>
          )}

          {/* Action Buttons */}
          <div className="pt-3 border-t border-neutral-200 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-xl border border-neutral-300 bg-white px-4 py-2 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-xl bg-cluvo-primary px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-cluvo-primary/90 transition-colors disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Applying Resolution...
                </>
              ) : (
                "Confirm & Resolve Task"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

