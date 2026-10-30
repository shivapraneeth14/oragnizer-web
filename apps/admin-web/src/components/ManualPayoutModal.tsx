import { useState, useEffect, useMemo } from "react"
import { supabase } from "../supabase"
import { formatCurrency } from "./TransactionDetailDrawer"

export interface EventSettlementMeta {
  id: string
  title: string
  startDate?: string | null
  price?: number
  gross: number
  platformFee: number
  netShare?: number
  refunds: number
  netOrganizerTotal?: number
  settled: number
  pending: number
  remainingBalance: number
  settlementStatus?: string
}

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
  eventSummaries?: EventSettlementMeta[]
  beneficiary: {
    account_holder: string
    bank_account_number: string
    bank_ifsc: string
    label?: string
  } | null
  defaultEventId?: string | null
  defaultAmountRupees?: string | null
}

type PayoutScope = "specific_event" | "entire_wallet"
type ChannelTab = "bank" | "upi" | "other"

const BANK_METHODS = [
  { id: "IMPS", label: "IMPS (Immediate Payment Service - Instant)" },
  { id: "NEFT", label: "NEFT (National Electronic Fund Transfer)" },
  { id: "RTGS", label: "RTGS (Real Time Gross Settlement)" },
  { id: "Bank Transfer", label: "Direct Wire / Corporate NetBanking" },
]

const UPI_METHODS = [
  { id: "UPI - Google Pay", label: "Google Pay (GPay UPI)" },
  { id: "UPI - PhonePe", label: "PhonePe UPI" },
  { id: "UPI - Paytm", label: "Paytm UPI" },
  { id: "UPI - BHIM", label: "BHIM / Govt UPI" },
  { id: "UPI", label: "Generic / Other UPI" },
]

const OTHER_METHODS = [
  { id: "Cheque", label: "Cheque Transfer" },
  { id: "Demand Draft", label: "Demand Draft (DD)" },
  { id: "Cash Voucher", label: "Cash Voucher / Physical Receipt" },
]

export default function ManualPayoutModal({
  isOpen,
  onClose,
  onSuccess,
  community,
  events,
  eventSummaries = [],
  beneficiary,
  defaultEventId,
  defaultAmountRupees,
}: Props) {
  const [scope, setScope] = useState<PayoutScope>("specific_event")
  const [channel, setChannel] = useState<ChannelTab>("bank")
  const [selectedEventId, setSelectedEventId] = useState<string>("")
  const [rupees, setRupees] = useState<string>("")

  // Bank fields
  const [bankMethod, setBankMethod] = useState<string>("IMPS")
  const [bankUtr, setBankUtr] = useState<string>("")

  // UPI fields
  const [upiMethod, setUpiMethod] = useState<string>("UPI - Google Pay")
  const [upiId, setUpiId] = useState<string>("")
  const [upiRef, setUpiRef] = useState<string>("")

  // Other manual fields
  const [otherMethod, setOtherMethod] = useState<string>("Cheque")
  const [instrumentRef, setInstrumentRef] = useState<string>("")
  const [issuingBank, setIssuingBank] = useState<string>("")

  // Common
  const [adminNotes, setAdminNotes] = useState<string>("")
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // Initialize or reset when modal opens
  useEffect(() => {
    if (isOpen) {
      const initialEventId = defaultEventId && defaultEventId !== "all" ? defaultEventId : events[0]?.id || ""
      const initialScope: PayoutScope = defaultEventId === "all" || !defaultEventId ? (events.length > 0 ? "specific_event" : "entire_wallet") : "specific_event"

      setScope(initialScope)
      setSelectedEventId(initialEventId)
      setChannel("bank")
      setBankMethod("IMPS")
      setBankUtr("")
      setUpiMethod("UPI - Google Pay")
      setUpiId("")
      setUpiRef("")
      setOtherMethod("Cheque")
      setInstrumentRef("")
      setIssuingBank("")
      setAdminNotes("")
      setError(null)

      if (defaultAmountRupees) {
        setRupees(defaultAmountRupees)
      } else {
        // Auto-compute default amount based on scope
        if (initialScope === "specific_event" && initialEventId) {
          const evSummary = eventSummaries.find((s) => s.id === initialEventId)
          if (evSummary && evSummary.remainingBalance > 0) {
            setRupees((evSummary.remainingBalance / 100).toFixed(2))
          } else {
            setRupees("")
          }
        } else if (community && community.wallet_balance > 0) {
          setRupees((community.wallet_balance / 100).toFixed(2))
        } else {
          setRupees("")
        }
      }
    }
  }, [isOpen, defaultEventId, defaultAmountRupees, events, eventSummaries, community])

  // Get active event summary
  const activeEventSummary = useMemo(() => {
    if (!selectedEventId) return null
    return eventSummaries.find((s) => s.id === selectedEventId) || null
  }, [selectedEventId, eventSummaries])

  // Handle scope change
  const handleScopeChange = (newScope: PayoutScope) => {
    setScope(newScope)
    setError(null)
    if (newScope === "entire_wallet") {
      if (community && community.wallet_balance > 0) {
        setRupees((community.wallet_balance / 100).toFixed(2))
      }
    } else {
      if (activeEventSummary && activeEventSummary.remainingBalance > 0) {
        setRupees((activeEventSummary.remainingBalance / 100).toFixed(2))
      }
    }
  }

  // Handle event selection change
  const handleEventChange = (newEvId: string) => {
    setSelectedEventId(newEvId)
    const evSummary = eventSummaries.find((s) => s.id === newEvId)
    if (evSummary && evSummary.remainingBalance > 0) {
      setRupees((evSummary.remainingBalance / 100).toFixed(2))
    }
  }

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

    // Determine reference number and method based on channel
    let finalRef = ""
    let finalMethod = ""
    let extraNotes = ""

    if (channel === "bank") {
      finalRef = bankUtr.trim()
      finalMethod = bankMethod
      if (!finalRef) {
        setError("Please provide the Banking UTR or Transaction Reference Number.")
        return
      }
    } else if (channel === "upi") {
      finalRef = upiRef.trim()
      finalMethod = upiMethod
      if (!upiId.trim()) {
        setError("Please provide the Recipient UPI ID / VPA.")
        return
      }
      if (!finalRef) {
        setError("Please provide the 12-digit UPI Reference / Transaction ID.")
        return
      }
      extraNotes = `[Recipient UPI: ${upiId.trim()}]`
    } else {
      finalRef = instrumentRef.trim()
      finalMethod = otherMethod
      if (!finalRef) {
        setError("Please provide the Cheque / Draft / Voucher Number.")
        return
      }
      if (issuingBank.trim()) {
        extraNotes = `[Issuing Bank: ${issuingBank.trim()}]`
      }
    }

    const combinedNotes = [adminNotes.trim(), extraNotes].filter(Boolean).join(" ")

    const targetEventId = scope === "specific_event" && selectedEventId ? selectedEventId : null

    setSubmitting(true)

    try {
      const { data, error: rpcErr } = await supabase.rpc("admin_record_manual_payout", {
        p_community_id: community.id,
        p_amount: parsedAmountPaise,
        p_utr: finalRef,
        p_payment_method: finalMethod,
        p_event_id: targetEventId,
        p_admin_notes: combinedNotes || null,
      })

      if (rpcErr) {
        throw new Error(rpcErr.message)
      }

      if (!data || data.ok === false) {
        throw new Error(data?.error || "Failed to record manual payout.")
      }

      // Dispatch payout email notification to organizer asynchronously
      if (data.payout_id) {
        supabase.functions
          .invoke("notify-payout", {
            body: { payout_id: data.payout_id },
          })
          .catch((err) => {
            console.warn("Async email notification error:", err)
          })
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
        className="fixed inset-0 bg-neutral-900/60 backdrop-blur-xs transition-opacity"
        onClick={() => !submitting && onClose()}
      />

      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative w-full max-w-xl rounded-2xl bg-white shadow-2xl border border-neutral-200 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
          {/* Header */}
          <div className="border-b border-neutral-200 bg-neutral-50/80 px-6 py-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-neutral-900">
                  Record Manual Settlement / Payout
                </h3>
                <p className="text-xs text-neutral-500 mt-0.5">
                  Record an offline payout (Bank / UPI / Cheque) issued to the organizer.
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

          <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[85vh] overflow-y-auto">
            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
                <svg className="h-4 w-4 shrink-0 text-red-600 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {/* Target Community & Live Wallet Header */}
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3.5 flex items-center justify-between">
              <div>
                <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">
                  Target Community
                </span>
                <p className="font-bold text-neutral-900 text-sm">{community.name}</p>
              </div>
              <div className="text-right">
                <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">
                  Available Wallet Balance
                </span>
                <p className="font-bold text-emerald-700 text-base">
                  {formatCurrency(community.wallet_balance)}
                </p>
              </div>
            </div>

            {/* 1. Settlement Scope Selector */}
            <div>
              <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider mb-1.5">
                Settlement Scope
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => handleScopeChange("specific_event")}
                  className={`flex flex-col items-start p-3 rounded-xl border text-left transition-all ${
                    scope === "specific_event"
                      ? "border-cluvo-primary bg-cluvo-primary/5 ring-1 ring-cluvo-primary"
                      : "border-neutral-200 hover:border-neutral-300 bg-white"
                  }`}
                >
                  <span className={`text-xs font-bold ${scope === "specific_event" ? "text-cluvo-primary" : "text-neutral-800"}`}>
                    🎯 Settle Specific Event
                  </span>
                  <span className="text-[11px] text-neutral-500 mt-0.5">
                    Link payout to one event's remaining due
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => handleScopeChange("entire_wallet")}
                  className={`flex flex-col items-start p-3 rounded-xl border text-left transition-all ${
                    scope === "entire_wallet"
                      ? "border-cluvo-primary bg-cluvo-primary/5 ring-1 ring-cluvo-primary"
                      : "border-neutral-200 hover:border-neutral-300 bg-white"
                  }`}
                >
                  <span className={`text-xs font-bold ${scope === "entire_wallet" ? "text-cluvo-primary" : "text-neutral-800"}`}>
                    🏦 Settle Entire Wallet
                  </span>
                  <span className="text-[11px] text-neutral-500 mt-0.5">
                    Clear all due balances across all events
                  </span>
                </button>
              </div>
            </div>

            {/* 2. Specific Event Selector & Live Event Financial Snapshot */}
            {scope === "specific_event" ? (
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-neutral-700">
                  Select Event to Settle <span className="text-red-500">*</span>
                </label>
                <select
                  value={selectedEventId}
                  onChange={(e) => handleEventChange(e.target.value)}
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-800 focus:border-cluvo-primary focus:outline-none bg-white"
                >
                  {events.length === 0 ? (
                    <option value="">No active events found for this community</option>
                  ) : (
                    events.map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.title}
                      </option>
                    ))
                  )}
                </select>

                {/* Event Financial Snapshot Box */}
                {activeEventSummary && (
                  <div className="rounded-xl border border-neutral-200 bg-neutral-50/70 p-3 text-xs space-y-2">
                    <div className="flex items-center justify-between border-b border-neutral-200 pb-2">
                      <span className="font-bold text-neutral-800">
                        Event Financial Breakdown
                      </span>
                      <button
                        type="button"
                        onClick={() => setRupees((activeEventSummary.remainingBalance / 100).toFixed(2))}
                        className="text-[11px] font-semibold text-cluvo-primary hover:underline"
                      >
                        ⚡ Auto-fill Due (₹{(activeEventSummary.remainingBalance / 100).toFixed(2)})
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
                      <div>
                        <span className="text-neutral-400 block">Gross Ticket Sales</span>
                        <span className="font-semibold text-neutral-800">
                          {formatCurrency(activeEventSummary.gross)}
                        </span>
                      </div>
                      <div>
                        <span className="text-neutral-400 block">Cluvo Platform Fee</span>
                        <span className="font-semibold text-neutral-800">
                          -{formatCurrency(activeEventSummary.platformFee)}
                        </span>
                      </div>
                      <div>
                        <span className="text-neutral-400 block">Refunds Deducted</span>
                        <span className="font-semibold text-neutral-800">
                          -{formatCurrency(activeEventSummary.refunds)}
                        </span>
                      </div>
                      <div>
                        <span className="text-neutral-400 block">Net Organizer Share</span>
                        <span className="font-semibold text-neutral-900">
                          {formatCurrency(
                            activeEventSummary.netOrganizerTotal ??
                              Math.max(0, activeEventSummary.gross - activeEventSummary.platformFee - activeEventSummary.refunds)
                          )}
                        </span>
                      </div>
                      <div>
                        <span className="text-neutral-400 block">Already Settled</span>
                        <span className="font-semibold text-emerald-700">
                          {formatCurrency(activeEventSummary.settled)}
                        </span>
                      </div>
                      <div>
                        <span className="text-neutral-400 block">Remaining Due</span>
                        <span className="font-bold text-cluvo-primary">
                          {formatCurrency(activeEventSummary.remainingBalance)}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Entire Community Wallet Breakdown Notice */
              <div className="rounded-xl border border-neutral-200 bg-neutral-50/70 p-3 text-xs space-y-2">
                <div className="flex items-center justify-between border-b border-neutral-200 pb-2">
                  <span className="font-bold text-neutral-800">
                    Contributing Community Events
                  </span>
                  <button
                    type="button"
                    onClick={() => setRupees((community.wallet_balance / 100).toFixed(2))}
                    className="text-[11px] font-semibold text-cluvo-primary hover:underline"
                  >
                    ⚡ Auto-fill Wallet Balance (₹{(community.wallet_balance / 100).toFixed(2)})
                  </button>
                </div>
                {eventSummaries.length > 0 ? (
                  <div className="max-h-28 overflow-y-auto divide-y divide-neutral-200/60 pr-1">
                    {eventSummaries.map((s) => (
                      <div key={s.id} className="py-1.5 flex items-center justify-between text-[11px]">
                        <span className="text-neutral-700 truncate max-w-[240px] font-medium">
                          {s.title}
                        </span>
                        <span className="font-semibold text-neutral-900 shrink-0">
                          Due: {formatCurrency(s.remainingBalance)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-neutral-500 text-[11px]">
                    Settle general wallet balance of {formatCurrency(community.wallet_balance)}.
                  </p>
                )}
              </div>
            )}

            {/* 3. Amount Field */}
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
                  min="0.01"
                  value={rupees}
                  onChange={(e) => setRupees(e.target.value)}
                  placeholder="0.00"
                  required
                  className="w-full rounded-lg border border-neutral-300 pl-8 pr-3 py-2 text-sm font-semibold text-neutral-900 focus:border-cluvo-primary focus:outline-none"
                />
              </div>
              {isOverBalance && (
                <p className="text-[11px] text-amber-600 font-medium mt-1">
                  ⚠️ Note: Amount ({formatCurrency(parsedAmountPaise)}) exceeds available wallet balance ({formatCurrency(community.wallet_balance)}).
                </p>
              )}
            </div>

            {/* 4. Payment Channel Tabs */}
            <div>
              <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider mb-1.5">
                Payment Channel
              </label>
              <div className="flex border-b border-neutral-200 gap-4 mb-3">
                <button
                  type="button"
                  onClick={() => setChannel("bank")}
                  className={`pb-2 text-xs font-bold transition-colors border-b-2 -mb-px ${
                    channel === "bank"
                      ? "border-cluvo-primary text-cluvo-primary"
                      : "border-transparent text-neutral-500 hover:text-neutral-800"
                  }`}
                >
                  🏦 Bank Transfer
                </button>
                <button
                  type="button"
                  onClick={() => setChannel("upi")}
                  className={`pb-2 text-xs font-bold transition-colors border-b-2 -mb-px ${
                    channel === "upi"
                      ? "border-cluvo-primary text-cluvo-primary"
                      : "border-transparent text-neutral-500 hover:text-neutral-800"
                  }`}
                >
                  📱 UPI Transfer
                </button>
                <button
                  type="button"
                  onClick={() => setChannel("other")}
                  className={`pb-2 text-xs font-bold transition-colors border-b-2 -mb-px ${
                    channel === "other"
                      ? "border-cluvo-primary text-cluvo-primary"
                      : "border-transparent text-neutral-500 hover:text-neutral-800"
                  }`}
                >
                  📝 Other Manual
                </button>
              </div>

              {/* Tab 1: Bank Transfer Content */}
              {channel === "bank" && (
                <div className="space-y-3">
                  {/* Beneficiary Card */}
                  {beneficiary ? (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-2.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-emerald-900 truncate">
                          Beneficiary: {beneficiary.account_holder}
                        </span>
                        <span className="rounded bg-emerald-200/60 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800 shrink-0">
                          Linked Bank
                        </span>
                      </div>
                      <p className="text-neutral-600 mt-0.5 font-mono text-[11px]">
                        A/C: {beneficiary.bank_account_number} • IFSC: {beneficiary.bank_ifsc}
                        {beneficiary.label ? ` • ${beneficiary.label}` : ""}
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
                      ⚠️ Organizer has not linked an active beneficiary bank account. Verify details independently.
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-neutral-700 mb-1">
                        Bank Transfer Mode
                      </label>
                      <select
                        value={bankMethod}
                        onChange={(e) => setBankMethod(e.target.value)}
                        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-800 focus:border-cluvo-primary focus:outline-none bg-white"
                      >
                        {BANK_METHODS.map((m) => (
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
                        value={bankUtr}
                        onChange={(e) => setBankUtr(e.target.value)}
                        placeholder="e.g. UTR1234567890"
                        required={channel === "bank"}
                        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs font-mono font-medium text-neutral-900 focus:border-cluvo-primary focus:outline-none uppercase"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 2: UPI Transfer Content */}
              {channel === "upi" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-neutral-700 mb-1">
                        UPI App / Mode
                      </label>
                      <select
                        value={upiMethod}
                        onChange={(e) => setUpiMethod(e.target.value)}
                        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-800 focus:border-cluvo-primary focus:outline-none bg-white"
                      >
                        {UPI_METHODS.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-neutral-700 mb-1">
                        Recipient UPI ID / VPA <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={upiId}
                        onChange={(e) => setUpiId(e.target.value)}
                        placeholder="e.g. organizer@okhdfcbank"
                        required={channel === "upi"}
                        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-900 focus:border-cluvo-primary focus:outline-none lowercase"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-neutral-700 mb-1">
                      UPI 12-Digit Reference / Ref ID <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={upiRef}
                      onChange={(e) => setUpiRef(e.target.value)}
                      placeholder="e.g. 430129381029"
                      required={channel === "upi"}
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs font-mono font-medium text-neutral-900 focus:border-cluvo-primary focus:outline-none"
                    />
                  </div>
                </div>
              )}

              {/* Tab 3: Other Manual Content */}
              {channel === "other" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-neutral-700 mb-1">
                        Instrument Type
                      </label>
                      <select
                        value={otherMethod}
                        onChange={(e) => setOtherMethod(e.target.value)}
                        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-800 focus:border-cluvo-primary focus:outline-none bg-white"
                      >
                        {OTHER_METHODS.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-neutral-700 mb-1">
                        Cheque / Voucher Number <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={instrumentRef}
                        onChange={(e) => setInstrumentRef(e.target.value)}
                        placeholder="e.g. CHQ-004521"
                        required={channel === "other"}
                        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs font-mono font-medium text-neutral-900 focus:border-cluvo-primary focus:outline-none uppercase"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-neutral-700 mb-1">
                      Issuing Bank / Branch / Note
                    </label>
                    <input
                      type="text"
                      value={issuingBank}
                      onChange={(e) => setIssuingBank(e.target.value)}
                      placeholder="e.g. HDFC Bank, Koramangala 4th Block"
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs text-neutral-900 focus:border-cluvo-primary focus:outline-none"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* 5. Admin Internal Notes */}
            <div>
              <label className="block text-xs font-semibold text-neutral-700 mb-1">
                Admin Audit Notes (Optional)
              </label>
              <textarea
                value={adminNotes}
                onChange={(e) => setAdminNotes(e.target.value)}
                placeholder="e.g. Transferred via Corporate NetBanking for final ticket settlements."
                rows={2}
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-xs text-neutral-800 focus:border-cluvo-primary focus:outline-none resize-none"
              />
            </div>

            {/* Notice & Clarification */}
            <div className="rounded-xl bg-amber-50/80 border border-amber-200/80 p-3 text-[11px] text-amber-900 leading-relaxed">
              <span className="font-bold">ℹ️ Audit & Reconciliation Workflow:</span>
              <p className="mt-0.5">
                This entry records an offline manual transfer. An automated email with transfer details will be dispatched to the organizer. The payout will show as <strong>Pending Organizer Confirmation</strong> until they digitally accept it, upon which the community wallet will be deducted.
              </p>
            </div>

            {/* Footer Buttons */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-200">
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
                    Recording Payout...
                  </>
                ) : (
                  "Record Payout & Notify Organizer"
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
