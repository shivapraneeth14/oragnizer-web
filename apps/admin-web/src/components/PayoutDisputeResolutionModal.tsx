import { useState } from "react"
import { supabase } from "../supabase"
import { FinancialTransaction, formatCurrency, formatDateTime } from "./TransactionDetailDrawer"

interface Props {
  isOpen: boolean
  transaction: FinancialTransaction | null
  onClose: () => void
  onSuccess: () => void
}

type DisputeResolutionAction = "cancel_disputed_payout" | "confirm_received_payout"

export default function PayoutDisputeResolutionModal({
  isOpen,
  transaction,
  onClose,
  onSuccess,
}: Props) {
  const [resolutionAction, setResolutionAction] = useState<DisputeResolutionAction>("cancel_disputed_payout")
  const [notes, setNotes] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen || !transaction) return null

  const isDisputed = transaction.status === "disputed"
  const isPending = transaction.status === "pending_confirmation"

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
      if (isDisputed) {
        const { data, error: rpcError } = await supabase.rpc("admin_resolve_payout_dispute", {
          p_payout_id: transaction.transaction_id,
          p_resolution: resolutionAction,
          p_resolution_notes: cleanNotes,
        })

        if (rpcError) throw rpcError
        if (!data || data.ok === false) {
          throw new Error(data?.message || data?.error || "Failed to resolve payout dispute.")
        }
      } else if (isPending) {
        const { data, error: rpcError } = await supabase.rpc("admin_cancel_manual_payout", {
          p_payout_id: transaction.transaction_id,
          p_cancel_reason: cleanNotes,
        })

        if (rpcError) throw rpcError
        if (!data || data.ok === false) {
          throw new Error(data?.message || data?.error || "Failed to cancel pending payout.")
        }
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-2xs"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-neutral-200 animate-in fade-in zoom-in-95 duration-150 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-100 pb-3">
          <div>
            <h3 className="text-base font-bold text-neutral-900">
              {isDisputed ? "Resolve Payout Dispute" : "Cancel Pending Settlement"}
            </h3>
            <p className="text-xs text-neutral-500 mt-0.5">
              {isDisputed
                ? "The organizer has disputed this manual bank settlement. Review the claim and take corrective action."
                : "Cancel an unconfirmed settlement to unlock reserved wallet balance."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1 text-neutral-400 hover:text-neutral-700"
          >
            ✕
          </button>
        </div>

        {/* Transaction Summary Card */}
        <div className="rounded-xl border border-neutral-200 bg-neutral-50/70 p-3.5 space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-neutral-500">Amount Recorded:</span>
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
            <span className="text-neutral-500">Beneficiary / Scope:</span>
            <span className="font-medium text-neutral-800">
              {transaction.attendee_name || transaction.event_title || "General Wallet"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-500">Recorded On:</span>
            <span className="text-neutral-700">{formatDateTime(transaction.created_at)}</span>
          </div>

          {/* Organizer Dispute Reason if disputed */}
          {isDisputed && transaction.refund_reason && (
            <div className="mt-2 rounded-lg bg-red-50 p-2.5 border border-red-200 text-red-900">
              <span className="font-bold block mb-0.5">Organizer Dispute Claim:</span>
              <p className="italic">{transaction.refund_reason}</p>
            </div>
          )}
        </div>

        {/* Error Banner */}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <span className="font-bold text-red-600">✕</span>
            <span>{error}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {isDisputed && (
            <div className="space-y-2">
              <label className="block text-xs font-bold text-neutral-800">
                Resolution Decision <span className="text-red-500">*</span>
              </label>
              <div className="space-y-2">
                <label className="flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors border-neutral-200 hover:bg-neutral-50 has-[:checked]:border-cluvo-primary has-[:checked]:bg-purple-50/20">
                  <input
                    type="radio"
                    name="resolution"
                    value="cancel_disputed_payout"
                    checked={resolutionAction === "cancel_disputed_payout"}
                    onChange={() => setResolutionAction("cancel_disputed_payout")}
                    className="mt-0.5 text-cluvo-primary focus:ring-cluvo-primary"
                  />
                  <div>
                    <span className="text-xs font-bold text-neutral-900 block">
                      Cancel Disputed Settlement (Release Reserved Balance)
                    </span>
                    <span className="text-[11px] text-neutral-500 block mt-0.5">
                      Use if the external bank transfer failed, reversed, or was sent to an incorrect account. The reserved wallet funds will be unlocked back to the organizer with 0 wallet debit.
                    </span>
                  </div>
                </label>

                <label className="flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors border-neutral-200 hover:bg-neutral-50 has-[:checked]:border-cluvo-primary has-[:checked]:bg-purple-50/20">
                  <input
                    type="radio"
                    name="resolution"
                    value="confirm_received_payout"
                    checked={resolutionAction === "confirm_received_payout"}
                    onChange={() => setResolutionAction("confirm_received_payout")}
                    className="mt-0.5 text-cluvo-primary focus:ring-cluvo-primary"
                  />
                  <div>
                    <span className="text-xs font-bold text-neutral-900 block">
                      Confirm Receipt & Debit Wallet
                    </span>
                    <span className="text-[11px] text-neutral-500 block mt-0.5">
                      Use after verifying with bank statement that funds were delivered to the organizer. This permanently marks the payout as settled and debits the organizer's community wallet.
                    </span>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* Audit Notes Input */}
          <div>
            <label className="block text-xs font-bold text-neutral-800 mb-1">
              {isDisputed ? "Resolution Audit Notes" : "Cancellation Reason"}{" "}
              <span className="text-red-500">* (min 10 characters)</span>
            </label>
            <textarea
              required
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                isDisputed
                  ? "Detail the banking investigation, communication with organizer, or reversal confirmation..."
                  : "Detail the reason for cancelling this pending payout (e.g. incorrect UTR entered, duplicate submission)..."
              }
              className="w-full rounded-xl border border-neutral-300 p-2.5 text-xs text-neutral-900 focus:border-cluvo-primary focus:outline-none"
            />
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-100">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg border border-neutral-200 px-4 py-2 text-xs font-semibold text-neutral-700 hover:bg-neutral-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className={`rounded-lg px-4 py-2 text-xs font-bold text-white transition-colors disabled:opacity-50 ${
                isDisputed && resolutionAction === "confirm_received_payout"
                  ? "bg-emerald-600 hover:bg-emerald-700"
                  : "bg-red-600 hover:bg-red-700"
              }`}
            >
              {submitting
                ? "Processing..."
                : isDisputed
                ? resolutionAction === "confirm_received_payout"
                  ? "Confirm & Debit Wallet"
                  : "Cancel Settlement & Unlock Funds"
                : "Cancel Pending Settlement"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

