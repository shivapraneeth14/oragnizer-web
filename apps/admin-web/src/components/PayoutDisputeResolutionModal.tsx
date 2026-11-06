import { useState } from "react"
import { supabase } from "../supabase"
import { FinancialTransaction, formatCurrency } from "./TransactionDetailDrawer"

/**
 * Which admin action the settlement modal should perform.
 *
 *   cancel          — Cancel a DISPUTED payout (release the hold, wallet untouched)
 *   cancel_pending  — Cancel a PENDING_CONFIRMATION payout (release the hold)
 *   reconfirm       — Same row, same UTR → pending_confirmation, organizer re-notified
 *   force_received  — Same row → success, wallet debited exactly once
 */
export type PayoutDisputeMode = "cancel" | "cancel_pending" | "reconfirm" | "force_received"

interface Props {
  isOpen: boolean
  transaction: FinancialTransaction | null
  onClose: () => void
  onSuccess: () => void
  mode?: PayoutDisputeMode
}

const COPY: Record<
  PayoutDisputeMode,
  {
    title: string
    subtitle: string
    notesLabel: string
    placeholder: string
    submitLabel: string
    submitClass: string
  }
> = {
  cancel: {
    title: "Cancel Disputed Settlement",
    subtitle:
      "Cancel this disputed payout and release the reserved amount back to the organizer's available wallet. The wallet is not debited.",
    notesLabel: "Cancellation Reason (min 10 chars)",
    placeholder:
      "Detail the reason for cancelling this disputed payout (e.g. transfer failed, duplicate submission, organizer requested cancellation)...",
    submitLabel: "Cancel Settlement & Release Funds",
    submitClass: "bg-red-600 hover:bg-red-700",
  },
  cancel_pending: {
    title: "Cancel Pending Settlement",
    subtitle:
      "Cancel this payout while it is still awaiting organizer confirmation. The reserved amount is released and the wallet is not debited.",
    notesLabel: "Cancellation Reason (min 10 chars)",
    placeholder:
      "Detail the reason for cancelling this pending payout (e.g. wrong bank details, duplicate submission)...",
    submitLabel: "Cancel Pending Settlement",
    submitClass: "bg-red-600 hover:bg-red-700",
  },
  reconfirm: {
    title: "Ask Organizer to Re-confirm",
    subtitle:
      "Re-send the confirmation request to the organizer. This keeps the same payout row and the same UTR and moves it back to pending confirmation.",
    notesLabel: "Investigation Notes (min 10 chars)",
    placeholder:
      "Detail the banking investigation and what you communicated to the organizer...",
    submitLabel: "Request Re-confirmation",
    submitClass: "bg-purple-600 hover:bg-purple-700",
  },
  force_received: {
    title: "Force Mark Received",
    subtitle:
      "Only use this after verifying the transfer in the bank statement. This marks the payout settled and debits the organizer's wallet exactly once.",
    notesLabel: "Verification Evidence (min 10 chars)",
    placeholder:
      "Detail the bank statement reference, date, and how the payment was verified...",
    submitLabel: "Mark as Received",
    submitClass: "bg-emerald-600 hover:bg-emerald-700",
  },
}

export default function PayoutDisputeResolutionModal({
  isOpen,
  transaction,
  onClose,
  onSuccess,
  mode,
}: Props) {
  // Hooks must run before any early return, otherwise opening the modal throws
  // "Rendered more hooks than during the previous render".
  const [notes, setNotes] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen || !transaction) return null

  const activeMode: PayoutDisputeMode = mode ?? "cancel"
  const copy = COPY[activeMode]

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const cleanNotes = notes.trim()
    if (cleanNotes.length < 10) {
      setError("Audit notes and explanation are required (minimum 10 characters).")
      return
    }

    setSubmitting(true)

    try {
      if (activeMode === "cancel" || activeMode === "cancel_pending") {
        if (activeMode === "cancel") {
          const { data, error: rpcError } = await supabase.rpc("admin_resolve_payout_dispute", {
            p_payout_id: transaction.transaction_id,
            p_resolution: "cancel_disputed_payout",
            p_resolution_notes: cleanNotes,
          })
          if (rpcError) throw rpcError
          if (data && data.ok === false) {
            throw new Error(data?.message || data?.error || "Failed to cancel disputed payout.")
          }
        } else {
          const { data, error: rpcError } = await supabase.rpc("admin_cancel_manual_payout", {
            p_payout_id: transaction.transaction_id,
            p_cancel_reason: cleanNotes,
          })
          if (rpcError) throw rpcError
          if (data && data.ok === false) {
            throw new Error(data?.message || data?.error || "Failed to cancel pending payout.")
          }
        }
      } else if (activeMode === "reconfirm") {
        const { data, error: rpcError } = await supabase.rpc("admin_request_payout_reconfirmation", {
          p_payout_id: transaction.transaction_id,
          p_admin_notes: cleanNotes,
        })
        if (rpcError) throw rpcError
        if (data && data.ok === false) {
          throw new Error(data?.message || data?.error || "Failed to request payout reconfirmation.")
        }

        // Non-fatal: the status change already succeeded.
        await supabase.functions
          .invoke("notify-payout", {
            body: { payout_id: transaction.transaction_id, context: "reconfirmed" },
          })
          .catch(() => {})
      } else {
        const { data, error: rpcError } = await supabase.rpc("admin_resolve_payout_dispute", {
          p_payout_id: transaction.transaction_id,
          p_resolution: "confirm_received_payout",
          p_resolution_notes: cleanNotes,
        })
        if (rpcError) throw rpcError
        if (data && data.ok === false) {
          throw new Error(data?.message || data?.error || "Failed to mark payout as received.")
        }

        await supabase.functions
          .invoke("notify-payout", {
            body: { payout_id: transaction.transaction_id, context: "verified" },
          })
          .catch(() => {})
      }

      onSuccess()
      onClose()
    } catch (err: any) {
      console.error("Payout action failed:", err)
      setError(err?.message || "Failed to process settlement request.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-neutral-200 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-neutral-100 pb-3">
          <div>
            <h3 className="text-base font-bold text-neutral-900">{copy.title}</h3>
            <p className="text-xs text-neutral-500 mt-0.5">{copy.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1 text-neutral-400 hover:text-neutral-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/70 p-3.5 space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-neutral-500">Amount Reserved:</span>
              <span className="font-extrabold text-neutral-900">
                {formatCurrency(transaction.money_out || transaction.gross_amount)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">Banking UTR / Ref:</span>
              <span className="font-mono font-semibold text-neutral-800">
                {transaction.reference_id || "—"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">Scope:</span>
              <span className="font-medium text-neutral-800">
                {transaction.attendee_name || transaction.event_title || "General Wallet"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">Status:</span>
              <span className="font-semibold text-neutral-800">{transaction.status}</span>
            </div>
            {transaction.refund_reason && activeMode === "reconfirm" && (
              <div className="pt-1.5 border-t border-neutral-200">
                <span className="text-neutral-500 block">Organizer Dispute Claim:</span>
                <span className="text-neutral-800">{transaction.refund_reason}</span>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-bold text-neutral-800 mb-1">
              {copy.notesLabel} <span className="text-red-500">*</span>
            </label>
            <textarea
              required
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={copy.placeholder}
              className="w-full rounded-xl border border-neutral-300 p-2.5 text-xs text-neutral-900 focus:border-cluvo-primary focus:outline-none"
            />
          </div>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
              <span className="font-bold text-red-600">✕</span>
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-100">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg border border-neutral-200 px-4 py-2 text-xs font-semibold text-neutral-700 hover:bg-neutral-100"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={submitting}
              className={`rounded-lg px-4 py-2 text-xs font-bold text-white transition-colors disabled:opacity-50 ${copy.submitClass}`}
            >
              {submitting ? "Processing..." : copy.submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
