import { useEffect, useState } from "react"
import { supabase } from "../supabase"
import { FinancialTransaction, formatCurrency } from "./TransactionDetailDrawer"

interface Props {
  isOpen: boolean
  transaction: FinancialTransaction | null
  onClose: () => void
  onSuccess: () => void
}

const PAYMENT_METHODS = [
  { id: "IMPS", label: "IMPS (Immediate Payment Service - Instant)" },
  { id: "NEFT", label: "NEFT (National Electronic Fund Transfer)" },
  { id: "RTGS", label: "RTGS (Real Time Gross Settlement)" },
  { id: "UPI", label: "UPI / Other" },
]

/**
 * Reissue a disputed payout.
 *
 * The disputed row is cancelled and a BRAND NEW payout row is created with a
 * NEW UTR. The amount is copied from the original row, so there is no amount
 * input here — the RPC does not accept one on purpose.
 */
export default function ReissuePayoutModal({ isOpen, transaction, onClose, onSuccess }: Props) {
  const [utr, setUtr] = useState("")
  const [paymentMethod, setPaymentMethod] = useState("IMPS")
  const [notes, setNotes] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset the form whenever a different transaction is opened.
  useEffect(() => {
    if (!isOpen) return
    setUtr("")
    setPaymentMethod(
      PAYMENT_METHODS.some((m) => m.id === transaction?.payment_method)
        ? (transaction?.payment_method as string)
        : "IMPS"
    )
    setNotes("")
    setError(null)
    setSubmitting(false)
  }, [isOpen, transaction?.transaction_id, transaction?.payment_method])

  if (!isOpen || !transaction) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const cleanUtr = utr.trim()
    const cleanNotes = notes.trim()

    if (cleanUtr.length < 4) {
      setError("A valid new UTR / bank reference is required.")
      return
    }
    if (transaction.reference_id && cleanUtr === transaction.reference_id.trim()) {
      setError("The new UTR must be different from the disputed payout's original UTR.")
      return
    }
    if (cleanNotes.length < 10) {
      setError("Audit notes are required (minimum 10 characters).")
      return
    }

    setSubmitting(true)
    try {
      const { data, error: rpcError } = await supabase.rpc("admin_reissue_disputed_payout", {
        p_payout_id: transaction.transaction_id,
        p_utr: cleanUtr,
        p_payment_method: paymentMethod,
        p_admin_notes: cleanNotes,
      })

      if (rpcError) throw rpcError
      if (data && data.ok === false) {
        throw new Error(data?.message || data?.error || "Failed to reissue payout.")
      }

      const newPayoutId = data?.new_payout_id
      if (newPayoutId) {
        // Non-fatal: the reissue already succeeded.
        await supabase.functions
          .invoke("notify-payout", {
            body: { payout_id: newPayoutId, context: "reissued" },
          })
          .catch(() => {})
      }

      onSuccess()
      onClose()
    } catch (err: any) {
      console.error("Payout reissue failed:", err)
      setError(err?.message || "Failed to reissue the disputed payout.")
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
            <h3 className="text-base font-bold text-neutral-900">Resolve &amp; Reissue Payout</h3>
            <p className="text-xs text-neutral-500 mt-0.5">
              Cancels the disputed row and creates a new payout awaiting the organizer's confirmation.
            </p>
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
              <span className="text-neutral-500">Reissue Amount (fixed):</span>
              <span className="font-extrabold text-neutral-900">
                {formatCurrency(transaction.money_out || transaction.gross_amount)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">Previous UTR:</span>
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
            {transaction.refund_reason && (
              <div className="pt-1.5 border-t border-neutral-200">
                <span className="text-neutral-500 block">Organizer Dispute Claim:</span>
                <span className="text-neutral-800">{transaction.refund_reason}</span>
              </div>
            )}
            <p className="pt-1.5 border-t border-neutral-200 text-[11px] text-neutral-500">
              The amount cannot be edited — a reissue always pays the disputed amount. The organizer's
              wallet is not debited until they confirm the new transfer.
            </p>
          </div>

          <div>
            <label className="block text-xs font-bold text-neutral-800 mb-1">
              New UTR / Bank Reference <span className="text-red-500">*</span>
            </label>
            <input
              required
              type="text"
              value={utr}
              onChange={(e) => setUtr(e.target.value)}
              placeholder="e.g. 426818293541"
              className="w-full rounded-xl border border-neutral-300 p-2.5 text-xs font-mono text-neutral-900 focus:border-cluvo-primary focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-neutral-800 mb-1">Transfer Method</label>
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              className="w-full rounded-xl border border-neutral-300 p-2.5 text-xs text-neutral-900 focus:border-cluvo-primary focus:outline-none"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold text-neutral-800 mb-1">
              Admin Resolution Notes (min 10 chars) <span className="text-red-500">*</span>
            </label>
            <textarea
              required
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Explain why the original transfer failed and what was reissued..."
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
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-bold text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {submitting ? "Reissuing..." : "Reissue Payout"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
