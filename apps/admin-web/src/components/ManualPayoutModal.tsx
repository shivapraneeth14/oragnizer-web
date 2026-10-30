import { useState, useEffect } from "react"
import { supabase } from "../supabase"
import { formatCurrency } from "./TransactionDetailDrawer"

interface Props {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  community: {
    id: string
    name: string
    wallet_balance: number
  } | null
  events: Array<{
    id: string
    title: string
  }>
  beneficiary: {
    account_holder: string
    bank_account_number: string
    bank_ifsc: string
    label?: string
  } | null
  defaultEventId?: string | null
  defaultAmountRupees?: string | null
}

const PAYMENT_METHODS = [
  { id: "IMPS", label: "IMPS (Immediate Payment Service)" },
  { id: "NEFT", label: "NEFT (National Electronic Fund Transfer)" },
  { id: "RTGS", label: "RTGS (Real Time Gross Settlement)" },
  { id: "UPI", label: "UPI (Unified Payments Interface)" },
  { id: "Bank Transfer", label: "Direct Bank Transfer / Wire" },
]

export default function ManualPayoutModal({
  isOpen,
  onClose,
  onSuccess,
  community,
  events,
  beneficiary,
  defaultEventId,
  defaultAmountRupees,
}: Props) {
  const [eventId, setEventId] = useState<string>("all")
  const [rupees, setRupees] = useState<string>("")
  const [utr, setUtr] = useState<string>("")
  const [paymentMethod, setPaymentMethod] = useState<string>("IMPS")
  const [adminNotes, setAdminNotes] = useState<string>("")
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      setEventId(defaultEventId || "all")
      setRupees(defaultAmountRupees || "")
      setUtr("")
      setPaymentMethod("IMPS")
      setAdminNotes("")
      setError(null)
    }
  }, [isOpen, defaultEventId, defaultAmountRupees])

  if (!isOpen || !community) return null

  const parsedAmountPaise = Math.round((parseFloat(rupees) || 0) * 100)
  const isOverBalance = parsedAmountPaise > community.wallet_balance

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (parsedAmountPaise <= 0) {
      setError("Please enter a valid payout amount greater than ₹0.")
      return
    }

    if (!utr.trim()) {
      setError("Please provide the banking UTR or transaction reference number.")
      return
    }

    setSubmitting(true)

    try {
      const { data, error: rpcErr } = await supabase.rpc("admin_record_manual_payout", {
        p_community_id: community.id,
        p_amount: parsedAmountPaise,
        p_utr: utr.trim(),
        p_payment_method: paymentMethod,
        p_event_id: eventId === "all" || !eventId ? null : eventId,
        p_admin_notes: adminNotes.trim() || null,
      })

      if (rpcErr) {
        throw new Error(rpcErr.message)
      }

      if (!data || data.ok === false) {
        throw new Error(data?.error || "Failed to record manual payout.")
      }

      onSuccess()
      onClose()
    } catch (err: any) {
      setError(err?.message || "An unexpected error occurred while recording the payout.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-neutral-900/50 backdrop-blur-xs transition-opacity"
        onClick={() => !submitting && onClose()}
      />

      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-neutral-200 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
          {/* Header */}
          <div className="border-b border-neutral-200 bg-neutral-50/80 px-6 py-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-neutral-900">
                  Record Manual Bank Payout
                </h3>
                <p className="text-xs text-neutral-500 mt-0.5">
                  Record an offline bank transfer (IMPS/NEFT/UPI) to the organizer.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="rounded-lg p-1.5 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-200 transition-colors"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
                <svg className="h-4 w-4 shrink-0 text-red-600 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {/* Target Community & Wallet Balance */}
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3.5 flex items-center justify-between">
              <div>
                <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wide">
                  Target Community
                </span>
                <p className="font-bold text-neutral-900">{community.name}</p>
              </div>
              <div className="text-right">
                <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wide">
                  Available Wallet
                </span>
                <p className="font-bold text-emerald-700">
                  {formatCurrency(community.wallet_balance)}
                </p>
              </div>
            </div>

            {/* Target Event (Attribution) */}
            <div>
              <label className="block text-xs font-semibold text-neutral-700 mb-1">
                Attribute to Event (Optional)
              </label>
              <select
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-800 focus:border-cluvo-primary focus:outline-none bg-white"
              >
                <option value="all">General / Entire Community Wallet</option>
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.title}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-neutral-400 mt-1">
                Linking to a specific event lets you view this payout inside that event’s filtered passbook.
              </p>
            </div>

            {/* Destination Beneficiary Account Preview */}
            <div>
              <label className="block text-xs font-semibold text-neutral-700 mb-1">
                Destination Beneficiary Account
              </label>
              {beneficiary ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-emerald-900">
                      {beneficiary.account_holder}
                    </span>
                    <span className="rounded bg-emerald-200/60 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800">
                      Verified
                    </span>
                  </div>
                  <p className="text-neutral-600 mt-1 font-mono text-[11px]">
                    A/C: {beneficiary.bank_account_number} • IFSC: {beneficiary.bank_ifsc}
                  </p>
                  {beneficiary.label && (
                    <p className="text-neutral-500 text-[10px] mt-0.5">
                      Label: {beneficiary.label}
                    </p>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  ⚠️ Organizer has not linked a verified beneficiary account yet. Verify the bank account details independently before transferring funds.
                </div>
              )}
            </div>

            {/* Amount (₹) */}
            <div>
              <label className="block text-xs font-semibold text-neutral-700 mb-1">
                Payout Amount (₹) <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none font-bold text-neutral-400 text-sm">
                  ₹
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  value={rupees}
                  onChange={(e) => setRupees(e.target.value)}
                  placeholder="0.00"
                  required
                  className="w-full rounded-lg border border-neutral-300 pl-8 pr-3 py-2 text-sm font-semibold text-neutral-900 focus:border-cluvo-primary focus:outline-none"
                />
              </div>
              {isOverBalance && (
                <p className="text-[11px] text-amber-600 font-medium mt-1">
                  ⚠️ Warning: Entered amount ({formatCurrency(parsedAmountPaise)}) exceeds current wallet balance ({formatCurrency(community.wallet_balance)}).
                </p>
              )}
            </div>

            {/* Payment Method & UTR */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  Transfer Mode
                </label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-800 focus:border-cluvo-primary focus:outline-none bg-white"
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  Banking UTR / Reference <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={utr}
                  onChange={(e) => setUtr(e.target.value)}
                  placeholder="e.g. UTR1234567890"
                  required
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs font-mono font-medium text-neutral-900 focus:border-cluvo-primary focus:outline-none uppercase"
                />
              </div>
            </div>

            {/* Admin Internal Notes */}
            <div>
              <label className="block text-xs font-semibold text-neutral-700 mb-1">
                Admin Audit Notes (Optional)
              </label>
              <textarea
                value={adminNotes}
                onChange={(e) => setAdminNotes(e.target.value)}
                placeholder="e.g. Transferred via HDFC Corporate NetBanking for October Ticket Settlements."
                rows={2}
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs text-neutral-800 focus:border-cluvo-primary focus:outline-none resize-none"
              />
            </div>

            {/* Notice */}
            <div className="rounded-lg bg-neutral-100 p-2.5 text-[11px] text-neutral-600">
              ℹ️ Once recorded, this entry will appear as <strong>Pending Organizer Confirmation</strong>. The organizer can digitally accept it from their Payout tab to reconcile and deduct their wallet.
            </div>

            {/* Buttons */}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="rounded-lg border border-neutral-200 px-4 py-2 text-xs font-semibold text-neutral-700 hover:bg-neutral-100 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-cluvo-primary px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-cluvo-primary/90 disabled:opacity-50 transition-colors"
              >
                {submitting ? (
                  <>
                    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Recording...
                  </>
                ) : (
                  "Record & Issue Settlement"
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
