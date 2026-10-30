import { useState, useEffect } from "react"

export interface FinancialTransaction {
  transaction_id: string
  created_at: string
  transaction_type: "ticket_sale" | "refund" | "payout_confirmed" | "payout_pending" | "payout_disputed"
  status: string
  description: string
  reference_id: string | null
  secondary_ref: string | null
  attendee_name: string | null
  attendee_email: string | null
  attendee_phone: string | null
  registration_id: string | null
  event_id: string | null
  event_title: string | null
  check_in_status: string | null
  gross_amount: number
  platform_fee: number
  organizer_share: number
  money_in: number
  money_out: number
  running_balance: number
  refund_reason: string | null
  admin_notes: string | null
  payment_method: string | null
  bank_details: {
    account_holder?: string
    bank_account_number?: string
    bank_ifsc?: string
    label?: string
  } | null
  confirmed_at: string | null
}

export function formatCurrency(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "₹0.00"
  const rupees = paise / 100
  return (
    "₹" +
    rupees.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  )
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
  } catch {
    return iso
  }
}

interface Props {
  transaction: FinancialTransaction | null
  onClose: () => void
}

export default function TransactionDetailDrawer({ transaction, onClose }: Props) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  if (!transaction) return null

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr))
    }, 2000)
  }

  const isCredit = transaction.money_in > 0
  const isRefund = transaction.transaction_type === "refund"
  const isPayout = transaction.transaction_type.startsWith("payout")

  const getStatusBadge = () => {
    if (transaction.status === "success" || transaction.status === "processed") {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-600"></span>
          Settled / Success
        </span>
      )
    }
    if (transaction.status === "refunded") {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-600/20">
          <span className="h-1.5 w-1.5 rounded-full bg-rose-600"></span>
          Refunded to Customer
        </span>
      )
    }
    if (transaction.status === "pending_confirmation") {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/20">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-600"></span>
          Awaiting Organizer Confirmation
        </span>
      )
    }
    if (transaction.status === "disputed") {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700 ring-1 ring-inset ring-red-600/20">
          <span className="h-1.5 w-1.5 rounded-full bg-red-600"></span>
          Disputed by Organizer
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-700 ring-1 ring-inset ring-neutral-500/20">
        <span className="h-1.5 w-1.5 rounded-full bg-neutral-500"></span>
        {transaction.status}
      </span>
    )
  }

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-neutral-900/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
        onClick={onClose}
      />

      <div className="fixed inset-y-0 right-0 flex max-w-full pl-10">
        <div className="w-screen max-w-lg bg-white shadow-2xl flex flex-col h-full animate-in slide-in-from-right duration-300">
          {/* Header */}
          <div className="border-b border-neutral-200 px-6 py-5 bg-neutral-50/70 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold tracking-wider uppercase text-neutral-400">
                  Transaction Audit
                </span>
                {getStatusBadge()}
              </div>
              <h2 className="text-lg font-bold text-neutral-900 mt-1">
                {transaction.description}
              </h2>
              <p className="text-xs text-neutral-500 mt-0.5">
                {formatDateTime(transaction.created_at)}
              </p>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors"
              title="Close panel (Esc)"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Body Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6 text-sm">
            {/* Net Amount Banner */}
            <div
              className={`rounded-xl p-4 border flex items-center justify-between ${
                isCredit
                  ? "bg-emerald-50/70 border-emerald-200 text-emerald-900"
                  : isRefund
                  ? "bg-rose-50/70 border-rose-200 text-rose-900"
                  : "bg-blue-50/70 border-blue-200 text-blue-900"
              }`}
            >
              <div>
                <p className="text-xs font-medium uppercase tracking-wide opacity-80">
                  {isCredit ? "Net Credited to Organizer" : isRefund ? "Refund Debited" : "Payout Debited"}
                </p>
                <p className="text-2xl font-black mt-0.5">
                  {isCredit
                    ? `+${formatCurrency(transaction.money_in)}`
                    : `-${formatCurrency(transaction.money_out)}`}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs font-medium uppercase tracking-wide opacity-80">
                  Running Balance
                </p>
                <p className="text-base font-bold mt-0.5">
                  {formatCurrency(transaction.running_balance)}
                </p>
              </div>
            </div>

            {/* Reference Identifiers Section */}
            <div className="rounded-xl border border-neutral-200 bg-white p-4 space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-400 flex items-center gap-1.5">
                <svg className="h-4 w-4 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Reference Identifiers (Ground Truth)
              </h3>

              {/* Primary Reference: Razorpay Payment ID or Refund ID or UTR */}
              {transaction.reference_id && (
                <div className="flex items-center justify-between rounded-lg bg-neutral-50 px-3 py-2 border border-neutral-100">
                  <div>
                    <span className="text-[11px] font-semibold text-neutral-500 block">
                      {isRefund
                        ? "Razorpay Refund ID"
                        : isPayout
                        ? "Banking UTR Number"
                        : "Razorpay Payment ID"}
                    </span>
                    <span className="font-mono text-xs font-semibold text-neutral-800 break-all select-all">
                      {transaction.reference_id}
                    </span>
                  </div>
                  <button
                    onClick={() => copyToClipboard(transaction.reference_id!, "ref_id")}
                    className="ml-2 shrink-0 rounded p-1 text-neutral-400 hover:text-cluvo-primary hover:bg-neutral-200 transition-colors"
                    title="Copy to clipboard"
                  >
                    {copiedKey === "ref_id" ? (
                      <span className="text-xs text-emerald-600 font-medium">Copied!</span>
                    ) : (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                </div>
              )}

              {/* Secondary Reference: Razorpay Order ID or Internal Ref */}
              {transaction.secondary_ref && (
                <div className="flex items-center justify-between rounded-lg bg-neutral-50 px-3 py-2 border border-neutral-100">
                  <div>
                    <span className="text-[11px] font-semibold text-neutral-500 block">
                      {transaction.secondary_ref.startsWith("order_")
                        ? "Razorpay Order ID"
                        : "Internal Transaction ID"}
                    </span>
                    <span className="font-mono text-xs font-semibold text-neutral-800 break-all select-all">
                      {transaction.secondary_ref}
                    </span>
                  </div>
                  <button
                    onClick={() => copyToClipboard(transaction.secondary_ref!, "sec_ref")}
                    className="ml-2 shrink-0 rounded p-1 text-neutral-400 hover:text-cluvo-primary hover:bg-neutral-200 transition-colors"
                    title="Copy to clipboard"
                  >
                    {copiedKey === "sec_ref" ? (
                      <span className="text-xs text-emerald-600 font-medium">Copied!</span>
                    ) : (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                </div>
              )}

              {/* Internal Database Record ID */}
              <div className="flex items-center justify-between rounded-lg bg-neutral-50 px-3 py-2 border border-neutral-100">
                <div>
                  <span className="text-[11px] font-semibold text-neutral-500 block">
                    Database Record UUID
                  </span>
                  <span className="font-mono text-[11px] text-neutral-600 break-all select-all">
                    {transaction.transaction_id}
                  </span>
                </div>
                <button
                  onClick={() => copyToClipboard(transaction.transaction_id, "db_id")}
                  className="ml-2 shrink-0 rounded p-1 text-neutral-400 hover:text-cluvo-primary hover:bg-neutral-200 transition-colors"
                  title="Copy to clipboard"
                >
                  {copiedKey === "db_id" ? (
                    <span className="text-xs text-emerald-600 font-medium">Copied!</span>
                  ) : (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Financial Ledger Split */}
            <div className="rounded-xl border border-neutral-200 bg-white p-4 space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-400 flex items-center gap-1.5">
                <svg className="h-4 w-4 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Financial Accounting Split
              </h3>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between py-1 border-b border-neutral-100">
                  <dt className="text-neutral-500">Gross Ticket Amount</dt>
                  <dd className="font-semibold text-neutral-900">
                    {formatCurrency(transaction.gross_amount)}
                  </dd>
                </div>
                <div className="flex justify-between py-1 border-b border-neutral-100">
                  <dt className="text-neutral-500">Cluvo Platform Fee (6%)</dt>
                  <dd className="font-semibold text-neutral-900">
                    {formatCurrency(transaction.platform_fee)}
                  </dd>
                </div>
                <div className="flex justify-between py-1 border-b border-neutral-100">
                  <dt className="text-neutral-500">Organizer Credit / Share</dt>
                  <dd className="font-bold text-cluvo-primary">
                    {formatCurrency(transaction.organizer_share)}
                  </dd>
                </div>
                <div className="flex justify-between py-1">
                  <dt className="text-neutral-500">Payment Gateway / Channel</dt>
                  <dd className="font-medium uppercase text-neutral-800">
                    {transaction.payment_method || "Razorpay"}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Customer / Attendee Context (Ticket sales & refunds) */}
            {transaction.attendee_name && (
              <div className="rounded-xl border border-neutral-200 bg-white p-4 space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-400 flex items-center gap-1.5">
                  <svg className="h-4 w-4 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  {isPayout ? "Beneficiary Details" : "Customer / Attendee Information"}
                </h3>
                <dl className="space-y-2 text-xs">
                  <div className="flex justify-between py-1 border-b border-neutral-100">
                    <dt className="text-neutral-500">Name</dt>
                    <dd className="font-semibold text-neutral-900">{transaction.attendee_name}</dd>
                  </div>
                  {transaction.attendee_email && (
                    <div className="flex justify-between py-1 border-b border-neutral-100">
                      <dt className="text-neutral-500">Email</dt>
                      <dd className="font-medium text-neutral-800">{transaction.attendee_email}</dd>
                    </div>
                  )}
                  {transaction.attendee_phone && (
                    <div className="flex justify-between py-1 border-b border-neutral-100">
                      <dt className="text-neutral-500">Phone</dt>
                      <dd className="font-medium text-neutral-800">{transaction.attendee_phone}</dd>
                    </div>
                  )}
                  {transaction.event_title && (
                    <div className="flex justify-between py-1 border-b border-neutral-100">
                      <dt className="text-neutral-500">Event</dt>
                      <dd className="font-medium text-neutral-900 text-right max-w-[240px] truncate">
                        {transaction.event_title}
                      </dd>
                    </div>
                  )}
                  {transaction.check_in_status && (
                    <div className="flex justify-between py-1">
                      <dt className="text-neutral-500">Check-in Status</dt>
                      <dd>
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            transaction.check_in_status === "Attended"
                              ? "bg-emerald-100 text-emerald-800"
                              : transaction.check_in_status === "Refunded"
                              ? "bg-rose-100 text-rose-800"
                              : "bg-blue-100 text-blue-800"
                          }`}
                        >
                          {transaction.check_in_status}
                        </span>
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            )}

            {/* Refund Reason Forensic details */}
            {isRefund && (
              <div className="rounded-xl border border-rose-200 bg-rose-50/40 p-4 space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-rose-800 flex items-center gap-1.5">
                  <svg className="h-4 w-4 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  Refund Justification & Reconciliation
                </h3>
                <p className="text-xs text-rose-950 font-medium">
                  {transaction.refund_reason || "Customer requested refund upon ticket cancellation."}
                </p>
                <div className="pt-2 text-[11px] text-rose-700 space-y-1">
                  <p>• Razorpay Refund ID: <span className="font-mono">{transaction.reference_id}</span></p>
                  <p>• Organizer wallet reduced by: <span className="font-semibold">{formatCurrency(transaction.money_out)}</span></p>
                  <p>• Platform fee retained: <span className="font-semibold">{formatCurrency(transaction.platform_fee)}</span></p>
                </div>
              </div>
            )}

            {/* Payout Transfer Audit Details */}
            {isPayout && (
              <div className="rounded-xl border border-neutral-200 bg-white p-4 space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-400 flex items-center gap-1.5">
                  <svg className="h-4 w-4 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                  </svg>
                  Destination Bank Account Details
                </h3>

                {transaction.bank_details ? (
                  <dl className="space-y-2 text-xs">
                    <div className="flex justify-between py-1 border-b border-neutral-100">
                      <dt className="text-neutral-500">Account Holder</dt>
                      <dd className="font-semibold text-neutral-900">{transaction.bank_details.account_holder}</dd>
                    </div>
                    <div className="flex justify-between py-1 border-b border-neutral-100">
                      <dt className="text-neutral-500">Bank Account No.</dt>
                      <dd className="font-mono font-semibold text-neutral-900">{transaction.bank_details.bank_account_number}</dd>
                    </div>
                    <div className="flex justify-between py-1 border-b border-neutral-100">
                      <dt className="text-neutral-500">IFSC Code</dt>
                      <dd className="font-mono font-semibold text-neutral-900">{transaction.bank_details.bank_ifsc}</dd>
                    </div>
                    {transaction.bank_details.label && (
                      <div className="flex justify-between py-1 border-b border-neutral-100">
                        <dt className="text-neutral-500">Account Label</dt>
                        <dd className="font-medium text-neutral-700">{transaction.bank_details.label}</dd>
                      </div>
                    )}
                  </dl>
                ) : (
                  <p className="text-xs text-neutral-500 italic">No linked beneficiary record found at payout time.</p>
                )}

                {transaction.admin_notes && (
                  <div className="mt-3 rounded-lg bg-neutral-50 p-2.5 border border-neutral-200">
                    <p className="text-[11px] font-semibold text-neutral-500">Admin Recording Notes</p>
                    <p className="text-xs text-neutral-800 mt-0.5">{transaction.admin_notes}</p>
                  </div>
                )}

                {/* Confirmation Status */}
                <div className="mt-3 pt-2 border-t border-neutral-100">
                  <p className="text-[11px] font-semibold text-neutral-500">Organizer Confirmation</p>
                  {transaction.confirmed_at ? (
                    <p className="text-xs text-emerald-700 font-medium mt-0.5">
                      ✓ Confirmed by Organizer on {formatDateTime(transaction.confirmed_at)}
                    </p>
                  ) : transaction.status === "disputed" ? (
                    <p className="text-xs text-rose-700 font-medium mt-0.5">
                      ⚠️ Disputed: {transaction.refund_reason || "Organizer reported discrepancy"}
                    </p>
                  ) : (
                    <p className="text-xs text-amber-600 font-medium mt-0.5">
                      ⏳ Pending digital confirmation by organizer in web dashboard
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-neutral-200 p-4 bg-neutral-50/70 flex justify-end">
            <button
              onClick={onClose}
              className="rounded-lg bg-neutral-900 px-4 py-2 text-xs font-semibold text-white hover:bg-neutral-800 transition-colors"
            >
              Close Inspector
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
