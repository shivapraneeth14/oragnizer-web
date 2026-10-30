import { useState, useEffect, useMemo, useCallback } from "react"
import { supabase } from "../../supabase"

interface Props {
  communityId: string | undefined
}

interface Beneficiary {
  id: string
  cashfree_beneficiary_id?: string
  account_holder: string
  bank_account_number: string
  bank_ifsc: string
  label?: string
  is_active: boolean
}

export interface OrganizerFinancialTransaction {
  created_at: string
  transaction_id: string
  transaction_type: "ticket_sale" | "refund" | "payout_confirmed" | "payout_pending" | "payout_disputed" | "credit" | "debit"
  status: string
  description: string
  reference_id: string | null
  secondary_ref?: string | null
  attendee_name?: string | null
  attendee_email?: string | null
  attendee_phone?: string | null
  registration_id?: string | null
  event_id?: string | null
  event_title?: string | null
  check_in_status?: string | null
  gross_amount?: number
  platform_fee?: number
  organizer_share?: number
  money_in?: number
  money_out?: number
  refund_reason?: string | null
  admin_notes?: string | null
  payment_method?: string | null
  bank_details?: {
    account_holder?: string
    bank_account_number?: string
    bank_ifsc?: string
    label?: string
  } | null
  confirmed_at?: string | null
  amount?: number
  running_balance?: number
}

interface EventItem {
  id: string
  title: string
  start_date?: string | null
  price?: number
  status?: string | null
}

type TypeFilter = "all" | "credit" | "debit" | "refund"

const formatCurrency = (paise: number) => {
  const rupees = (paise || 0) / 100
  return `₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: rupees % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

const fmtDateTime = (iso: string) => {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

export default function PayoutSection({ communityId }: Props) {
  const [walletBalance, setWalletBalance] = useState(0)
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([])
  const [events, setEvents] = useState<EventItem[]>([])
  const [transactions, setTransactions] = useState<OrganizerFinancialTransaction[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all")

  // Modal & Action states
  const [confirmingPayoutId, setConfirmingPayoutId] = useState<string | null>(null)
  const [disputeTargetPayout, setDisputeTargetPayout] = useState<OrganizerFinancialTransaction | null>(null)
  const [disputeReason, setDisputeReason] = useState<string>("")
  const [submittingDispute, setSubmittingDispute] = useState<boolean>(false)
  const [inspectedTx, setInspectedTx] = useState<OrganizerFinancialTransaction | null>(null)
  const [actionSuccessMessage, setActionSuccessMessage] = useState<string | null>(null)
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null)

  const activeBeneficiary = beneficiaries.find((b) => b.is_active)

  // Load community wallet, beneficiaries, events, and transactions
  const loadData = useCallback(async () => {
    if (!communityId) return
    setLoading(true)
    setActionErrorMessage(null)

    try {
      const [balanceRes, benRes, eventsRes, rpcTxRes] = await Promise.all([
        supabase.rpc("get_community_financials", { p_community_id: communityId }),
        supabase
          .from("community_beneficiaries")
          .select("*")
          .eq("community_id", communityId)
          .order("created_at", { ascending: false }),
        supabase
          .from("events")
          .select("id, title, start_date, price, status")
          .eq("community_id", communityId)
          .is("deleted_at", null)
          .order("start_date", { ascending: false }),
        supabase.rpc("get_organizer_financial_statement", {
          p_community_id: communityId,
          p_event_id: null,
        }),
      ])

      if (balanceRes.data?.[0]) {
        setWalletBalance(balanceRes.data[0].wallet_balance || 0)
      }
      if (benRes.data) {
        setBeneficiaries(benRes.data as Beneficiary[])
      }
      if (eventsRes.data) {
        setEvents(eventsRes.data as EventItem[])
      }

      if (rpcTxRes.data && Array.isArray(rpcTxRes.data)) {
        setTransactions(rpcTxRes.data as OrganizerFinancialTransaction[])
      } else {
        // Fallback to direct payout_items and payments query if needed
        const { data: payouts } = await supabase
          .from("payout_items")
          .select("*, events(id, title), community_beneficiaries(*)")
          .eq("community_id", communityId)
          .order("created_at", { ascending: false })

        if (payouts) {
          const fallbackTx: OrganizerFinancialTransaction[] = payouts.map((p) => ({
            created_at: p.created_at,
            transaction_id: p.id,
            transaction_type:
              p.status === "success"
                ? "payout_confirmed"
                : p.status === "disputed"
                ? "payout_disputed"
                : "payout_pending",
            status: p.status,
            description: `Payout → ${p.community_beneficiaries?.account_holder || "Bank Transfer"}`,
            reference_id: p.utr,
            secondary_ref: p.id,
            event_id: p.event_id,
            event_title: p.events?.title,
            gross_amount: p.amount,
            platform_fee: 0,
            organizer_share: p.amount,
            money_in: 0,
            money_out: p.amount,
            admin_notes: p.admin_notes,
            refund_reason: p.dispute_reason,
            payment_method: p.payment_method,
            confirmed_at: p.confirmed_at,
          }))
          setTransactions(fallbackTx)
        }
      }
    } catch (err: any) {
      console.error("Error loading organizer financial data:", err)
      setActionErrorMessage(err?.message || "Failed to load financial records.")
    } finally {
      setLoading(false)
    }
  }, [communityId])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Realtime updates for payout_items and communities wallet
  useEffect(() => {
    if (!communityId) return
    const channel = supabase
      .channel(`organizer-payouts-${communityId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "payout_items", filter: `community_id=eq.${communityId}` },
        () => {
          loadData()
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "communities", filter: `id=eq.${communityId}` },
        () => {
          loadData()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [communityId, loadData])

  // Escape key handler for dialogs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setInspectedTx(null)
        setDisputeTargetPayout(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Auto-dismiss success message
  useEffect(() => {
    if (actionSuccessMessage) {
      const timer = setTimeout(() => setActionSuccessMessage(null), 7000)
      return () => clearTimeout(timer)
    }
  }, [actionSuccessMessage])

  // Event Financial Breakdown & Pending Payouts Mapping
  const eventSummaries = useMemo(() => {
    const txByEvent = new Map<string, OrganizerFinancialTransaction[]>()
    for (const tx of transactions) {
      if (!tx.event_id) continue
      const list = txByEvent.get(tx.event_id) || []
      list.push(tx)
      txByEvent.set(tx.event_id, list)
    }

    return events.map((ev) => {
      const eventTxs = txByEvent.get(ev.id) || []
      let gross = 0
      let platformFee = 0
      let refunds = 0
      let settled = 0
      let disputed = 0
      const pendingPayouts: OrganizerFinancialTransaction[] = []

      for (const tx of eventTxs) {
        if (tx.transaction_type === "ticket_sale") {
          gross += tx.gross_amount || 0
          platformFee += tx.platform_fee || 0
        } else if (tx.transaction_type === "refund") {
          refunds += tx.money_out || 0
        } else if (tx.transaction_type.startsWith("payout")) {
          if (tx.status === "success" || tx.status === "processed") {
            settled += tx.money_out || 0
          } else if (tx.status === "pending_confirmation") {
            pendingPayouts.push(tx)
          } else if (tx.status === "disputed") {
            disputed += tx.money_out || 0
          }
        }
      }

      const pendingAmount = pendingPayouts.reduce((sum, p) => sum + (p.money_out || p.gross_amount || 0), 0)
      const netShare = Math.max(0, gross - platformFee - refunds)
      const remainingBalance = Math.max(0, netShare - settled - pendingAmount - disputed)

      return {
        id: ev.id,
        title: ev.title,
        startDate: ev.start_date,
        price: ev.price,
        status: ev.status,
        gross,
        platformFee,
        refunds,
        netShare,
        settled,
        pendingAmount,
        pendingPayouts,
        remainingBalance,
        hasPendingConfirmation: pendingPayouts.length > 0,
      }
    })
  }, [events, transactions])

  // General / Wallet-wide pending payouts (not tied to a specific event)
  const generalPendingPayouts = useMemo(() => {
    return transactions.filter(
      (tx) =>
        tx.transaction_type.startsWith("payout") &&
        tx.status === "pending_confirmation" &&
        !tx.event_id
    )
  }, [transactions])

  // Five-dimension settlement summary across the organizer passbook (Milestone D)
  const settlementSummary = useMemo(() => {
    let netEarned = 0
    let confirmedReceived = 0
    let inFlightPending = 0
    let disputed = 0

    for (const tx of transactions) {
      if (tx.transaction_type === "ticket_sale") {
        netEarned += (tx.organizer_share ?? (tx.money_in ?? 0))
      } else if (tx.transaction_type === "refund") {
        netEarned -= (tx.money_out ?? 0)
      } else if (tx.transaction_type.startsWith("payout")) {
        if (tx.status === "success" || tx.status === "processed" || tx.transaction_type === "payout_confirmed") {
          confirmedReceived += (tx.money_out ?? tx.gross_amount ?? 0)
        } else if (tx.status === "pending_confirmation" || tx.transaction_type === "payout_pending") {
          inFlightPending += (tx.money_out ?? tx.gross_amount ?? 0)
        } else if (tx.status === "disputed" || tx.transaction_type === "payout_disputed") {
          disputed += (tx.money_out ?? tx.gross_amount ?? 0)
        }
      }
    }

    return {
      netEarned,
      confirmedReceived,
      inFlightPending,
      disputed,
      uncommittedBalance: Math.max(0, walletBalance - inFlightPending - disputed),
    }
  }, [transactions, walletBalance])

  // Selected event summary if any
  const selectedEventSummary = useMemo(() => {
    if (!selectedEventId) return null
    return eventSummaries.find((s) => s.id === selectedEventId) || null
  }, [selectedEventId, eventSummaries])

  // Filter transactions for table
  const displayedTransactions = useMemo(() => {
    return transactions
      .filter((tx) => {
        if (selectedEventId && tx.event_id !== selectedEventId) return false
        if (typeFilter === "credit") return tx.transaction_type === "ticket_sale" || (tx.money_in || 0) > 0
        if (typeFilter === "debit") return tx.transaction_type.startsWith("payout") || (tx.money_out || 0) > 0
        if (typeFilter === "refund") return tx.transaction_type === "refund"
        return true
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [transactions, selectedEventId, typeFilter])

  // Confirm Payout Action
  const handleConfirmPayout = async (payoutId: string, amount: number) => {
    setActionErrorMessage(null)
    setConfirmingPayoutId(payoutId)

    try {
      const { data, error } = await supabase.rpc("organizer_confirm_manual_payout", {
        p_payout_id: payoutId,
      })

      if (error) throw error
      if (!data || data.ok === false) {
        throw new Error(data?.error || "Failed to confirm payout.")
      }

      setActionSuccessMessage(
        `✓ Payout of ${formatCurrency(amount)} successfully confirmed and reconciled with your community wallet!`
      )
      await loadData()
    } catch (err: any) {
      console.error("Payout confirmation failed:", err)
      setActionErrorMessage(err?.message || "Failed to confirm payout. Please try again.")
    } finally {
      setConfirmingPayoutId(null)
    }
  }

  // Dispute Payout Action
  const handleDisputeSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!disputeTargetPayout) return
    if (!disputeReason.trim()) {
      setActionErrorMessage("Please provide a reason for disputing this payout.")
      return
    }

    setSubmittingDispute(true)
    setActionErrorMessage(null)

    try {
      const { data, error } = await supabase.rpc("organizer_dispute_manual_payout", {
        p_payout_id: disputeTargetPayout.transaction_id,
        p_reason: disputeReason.trim(),
      })

      if (error) throw error
      if (!data || data.ok === false) {
        throw new Error(data?.error || "Failed to report dispute.")
      }

      setActionSuccessMessage(
        `⚠️ Dispute recorded. The admin team has been notified regarding Reference ${disputeTargetPayout.reference_id || disputeTargetPayout.transaction_id.slice(0, 8)}.`
      )
      setDisputeTargetPayout(null)
      setDisputeReason("")
      await loadData()
    } catch (err: any) {
      console.error("Payout dispute failed:", err)
      setActionErrorMessage(err?.message || "Failed to submit dispute. Please try again.")
    } finally {
      setSubmittingDispute(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h3 className="text-xl font-bold text-neutral-900 tracking-tight">
          Payouts & Financial Settlements
        </h3>
        <p className="mt-1 text-sm text-neutral-500">
          Reconcile ticket revenues, review event collections, and digitally confirm manual payouts directly into your community wallet.
        </p>
      </div>

      {/* Global Action Messages */}
      {actionSuccessMessage && (
        <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 flex items-start justify-between shadow-xs animate-in fade-in duration-200">
          <div className="flex items-center gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white text-xs font-bold">
              ✓
            </span>
            <span className="font-medium">{actionSuccessMessage}</span>
          </div>
          <button
            onClick={() => setActionSuccessMessage(null)}
            className="text-emerald-700 hover:text-emerald-900 text-xs font-bold ml-2"
          >
            ✕
          </button>
        </div>
      )}

      {actionErrorMessage && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900 flex items-start justify-between shadow-xs animate-in fade-in duration-200">
          <div className="flex items-center gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-600 text-white text-xs font-bold">
              !
            </span>
            <span className="font-medium">{actionErrorMessage}</span>
          </div>
          <button
            onClick={() => setActionErrorMessage(null)}
            className="text-red-700 hover:text-red-900 text-xs font-bold ml-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* Top Card: Community Wallet Balance & Beneficiary Details */}
      <div className="rounded-2xl border border-neutral-200/80 bg-white p-5 sm:p-6 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-100 pb-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                Community Wallet Balance
              </span>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-extrabold text-neutral-900">
                {formatCurrency(walletBalance)}
              </span>
              <span className="text-xs text-neutral-400">available funds</span>
            </div>
          </div>

          {activeBeneficiary ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 sm:max-w-xs text-xs">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-bold text-emerald-900 truncate">
                  {activeBeneficiary.label || activeBeneficiary.account_holder}
                </span>
                <span className="rounded bg-emerald-200/60 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800 shrink-0">
                  Linked Account
                </span>
              </div>
              <p className="font-mono text-neutral-600 text-[11px]">
                A/C: {activeBeneficiary.bank_account_number} • IFSC: {activeBeneficiary.bank_ifsc}
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              ⚠️ No verified bank beneficiary linked. Please add one under Community Settings.
            </div>
          )}
        </div>

        {/* Financial Settlement Breakdown (Milestone D) */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 pt-5 border-b border-neutral-100 pb-5">
          <div className="rounded-xl border border-neutral-100 bg-neutral-50/70 p-3">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-neutral-400">
              Net Earned
            </span>
            <div className="mt-1 text-base font-extrabold text-neutral-900">
              {formatCurrency(settlementSummary.netEarned)}
            </div>
            <span className="text-[10px] text-neutral-500">Sales less fee & refunds</span>
          </div>

          <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-emerald-800">
              Confirmed Received
            </span>
            <div className="mt-1 text-base font-extrabold text-emerald-700">
              {formatCurrency(settlementSummary.confirmedReceived)}
            </div>
            <span className="text-[10px] text-emerald-600">Settled to your bank</span>
          </div>

          <div className="rounded-xl border border-amber-100 bg-amber-50/40 p-3">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-amber-800">
              In-Flight Pending
            </span>
            <div className="mt-1 text-base font-extrabold text-amber-700">
              {formatCurrency(settlementSummary.inFlightPending)}
            </div>
            <span className="text-[10px] text-amber-600">Awaiting acceptance</span>
          </div>

          <div className="rounded-xl border border-rose-100 bg-rose-50/40 p-3">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-rose-800">
              Disputed
            </span>
            <div className="mt-1 text-base font-extrabold text-rose-700">
              {formatCurrency(settlementSummary.disputed)}
            </div>
            <span className="text-[10px] text-rose-600">Under admin review</span>
          </div>

          <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-3 col-span-2 sm:col-span-1">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-indigo-800">
              Uncommitted Balance
            </span>
            <div className="mt-1 text-base font-extrabold text-indigo-700">
              {formatCurrency(settlementSummary.uncommittedBalance)}
            </div>
            <span className="text-[10px] text-indigo-600">Available to withdraw</span>
          </div>
        </div>

        {/* General Wallet-Wide Pending Payouts (if any) */}
        {generalPendingPayouts.length > 0 && !selectedEventId && (
          <div className="mt-5 space-y-3">
            <h5 className="text-xs font-bold uppercase tracking-wider text-amber-900 flex items-center gap-1.5">
              <span>🔔</span> Pending General Wallet Payouts ({generalPendingPayouts.length})
            </h5>
            {generalPendingPayouts.map((payout) => (
              <div
                key={payout.transaction_id}
                className="rounded-xl border border-amber-300 bg-amber-50/70 p-4 text-xs space-y-3"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <span className="text-[11px] font-bold text-amber-800 uppercase tracking-wide">
                      Entire Wallet Settlement Initiated
                    </span>
                    <div className="text-base font-extrabold text-neutral-900 mt-0.5">
                      {formatCurrency(payout.money_out || payout.gross_amount || 0)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={confirmingPayoutId === payout.transaction_id}
                      onClick={() => handleConfirmPayout(payout.transaction_id, payout.money_out || payout.gross_amount || 0)}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-emerald-800 disabled:opacity-50 transition-colors"
                    >
                      {confirmingPayoutId === payout.transaction_id ? "Confirming..." : "✅ Accept & Confirm Payout"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDisputeTargetPayout(payout)}
                      className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 transition-colors"
                    >
                      ⚠️ Dispute
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] border-t border-amber-200/60 pt-2 text-neutral-700">
                  <div>
                    <span className="text-neutral-400 block">Transfer Mode</span>
                    <span className="font-semibold text-neutral-800">{payout.payment_method || "Bank Transfer"}</span>
                  </div>
                  <div>
                    <span className="text-neutral-400 block">Reference / UTR</span>
                    <span className="font-mono font-semibold text-neutral-900">{payout.reference_id || "—"}</span>
                  </div>
                  <div>
                    <span className="text-neutral-400 block">Date Issued</span>
                    <span className="font-medium text-neutral-700">{fmtDateTime(payout.created_at)}</span>
                  </div>
                </div>

                {payout.admin_notes && (
                  <p className="text-[11px] text-amber-900 bg-amber-100/60 rounded-md p-2">
                    <strong>Admin Note:</strong> {payout.admin_notes}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* View Switcher: Single Event Focus OR All Events Overview */}
      {selectedEventId && selectedEventSummary ? (
        /* ================= SINGLE EVENT VIEW ================= */
        <div className="space-y-6">
          {/* Back Navigation Bar */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setSelectedEventId(null)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 shadow-2xs transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to All Events Collections
            </button>
            <span className="text-xs text-neutral-400">
              Showing detailed statement for <strong>{selectedEventSummary.title}</strong>
            </span>
          </div>

          {/* Pending Payout Confirmation Banner (KEPT STRICTLY INSIDE THAT PARTICULAR EVENT ONLY) */}
          {selectedEventSummary.hasPendingConfirmation && (
            <div className="rounded-2xl border-2 border-amber-300 bg-amber-50/90 p-5 shadow-xs space-y-4">
              {selectedEventSummary.pendingPayouts.map((payout) => (
                <div key={payout.transaction_id} className="space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-white text-base shadow-xs">
                        🔔
                      </span>
                      <div>
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-amber-900">
                          Pending Payout Confirmation
                        </span>
                        <h4 className="text-lg font-black text-neutral-900">
                          {formatCurrency(payout.money_out || payout.gross_amount || 0)}
                        </h4>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={confirmingPayoutId === payout.transaction_id}
                        onClick={() => handleConfirmPayout(payout.transaction_id, payout.money_out || payout.gross_amount || 0)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-emerald-800 disabled:opacity-50 transition-colors"
                      >
                        {confirmingPayoutId === payout.transaction_id ? (
                          <>
                            <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                            Confirming...
                          </>
                        ) : (
                          "✅ Accept & Confirm Payout"
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDisputeTargetPayout(payout)}
                        className="rounded-xl border border-red-300 bg-white px-3.5 py-2 text-xs font-bold text-red-700 hover:bg-red-50 shadow-2xs transition-colors"
                      >
                        ⚠️ Report Issue / Dispute
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-amber-950 leading-relaxed bg-amber-100/60 rounded-xl p-3 border border-amber-200/80">
                    ℹ️ <strong>Action Required:</strong> The platform admin has recorded an offline settlement transfer of{" "}
                    <strong>{formatCurrency(payout.money_out || payout.gross_amount || 0)}</strong> to your account.
                    Please check your bank account or UPI app. Confirming will verify receipt and reconcile your community wallet balance.
                  </p>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] bg-white/70 rounded-xl p-3 border border-amber-200/60">
                    <div>
                      <span className="text-neutral-400 block font-medium">Transfer Channel</span>
                      <span className="font-semibold text-neutral-900">{payout.payment_method || "Bank Transfer"}</span>
                    </div>
                    <div>
                      <span className="text-neutral-400 block font-medium">Reference / UTR</span>
                      <span className="font-mono font-bold text-neutral-900 select-all">{payout.reference_id || "—"}</span>
                    </div>
                    <div>
                      <span className="text-neutral-400 block font-medium">Date Dispatched</span>
                      <span className="font-medium text-neutral-700">{fmtDateTime(payout.created_at)}</span>
                    </div>
                    <div>
                      <span className="text-neutral-400 block font-medium">Event</span>
                      <span className="font-semibold text-neutral-900 truncate block">{selectedEventSummary.title}</span>
                    </div>
                  </div>

                  {payout.admin_notes && (
                    <div className="text-[11px] text-neutral-700 bg-white/90 rounded-xl p-2.5 border border-amber-200/60">
                      <span className="font-bold text-neutral-900">Admin Remark:</span> {payout.admin_notes}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Event Financial Statement Banner: 6 KPIs */}
          <div className="rounded-2xl border border-neutral-200/80 bg-white p-5 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-neutral-100 pb-3">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-cluvo-primary">
                  Event Financial Statement
                </span>
                <h4 className="text-lg font-bold text-neutral-900">{selectedEventSummary.title}</h4>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-semibold text-neutral-700">
                  {selectedEventSummary.price ? `Ticket: ₹${selectedEventSummary.price}` : "Free Event"}
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    selectedEventSummary.remainingBalance === 0 && selectedEventSummary.settled > 0
                      ? "bg-emerald-100 text-emerald-800"
                      : selectedEventSummary.hasPendingConfirmation
                      ? "bg-amber-100 text-amber-800"
                      : "bg-blue-100 text-blue-800"
                  }`}
                >
                  {selectedEventSummary.remainingBalance === 0 && selectedEventSummary.settled > 0
                    ? "Fully Settled 🟢"
                    : selectedEventSummary.hasPendingConfirmation
                    ? "Confirmation Pending 🔔"
                    : "Due for Settlement"}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="rounded-xl bg-neutral-50 p-3">
                <span className="text-[11px] font-medium text-neutral-400">Gross Ticket Sales</span>
                <p className="text-base font-bold text-neutral-900 mt-0.5">
                  {formatCurrency(selectedEventSummary.gross)}
                </p>
              </div>
              <div className="rounded-xl bg-neutral-50 p-3">
                <span className="text-[11px] font-medium text-neutral-400">Cluvo Fee</span>
                <p className="text-base font-bold text-neutral-700 mt-0.5">
                  -{formatCurrency(selectedEventSummary.platformFee)}
                </p>
              </div>
              <div className="rounded-xl bg-neutral-50 p-3">
                <span className="text-[11px] font-medium text-neutral-400">Refunds Deducted</span>
                <p className="text-base font-bold text-neutral-700 mt-0.5">
                  -{formatCurrency(selectedEventSummary.refunds)}
                </p>
              </div>
              <div className="rounded-xl bg-neutral-50 p-3">
                <span className="text-[11px] font-medium text-neutral-400">Net Organizer Share</span>
                <p className="text-base font-bold text-neutral-900 mt-0.5">
                  {formatCurrency(selectedEventSummary.netShare)}
                </p>
              </div>
              <div className="rounded-xl bg-emerald-50/60 p-3">
                <span className="text-[11px] font-medium text-emerald-800">Settled Payouts</span>
                <p className="text-base font-bold text-emerald-700 mt-0.5">
                  {formatCurrency(selectedEventSummary.settled)}
                </p>
              </div>
              <div className="rounded-xl bg-blue-50/60 p-3">
                <span className="text-[11px] font-medium text-blue-800">Remaining Balance Due</span>
                <p className="text-base font-bold text-cluvo-primary mt-0.5">
                  {formatCurrency(selectedEventSummary.remainingBalance)}
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* ================= ALL EVENTS COLLECTIONS OVERVIEW ================= */
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-neutral-900 text-sm tracking-wide uppercase">
              Event Collections & Earnings ({events.length})
            </h4>
            <span className="text-xs text-neutral-500">
              Click any event to view its passbook & pending confirmations
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {eventSummaries.map((ev) => (
              <div
                key={ev.id}
                onClick={() => setSelectedEventId(ev.id)}
                className={`group relative rounded-2xl border p-4.5 transition-all cursor-pointer bg-white hover:shadow-md ${
                  ev.hasPendingConfirmation
                    ? "border-amber-300 ring-2 ring-amber-300/40 bg-amber-50/20"
                    : "border-neutral-200 hover:border-neutral-300"
                }`}
              >
                {/* Event Title & Date */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h5 className="font-bold text-neutral-900 text-sm group-hover:text-cluvo-primary transition-colors truncate">
                      {ev.title}
                    </h5>
                    <p className="text-[11px] text-neutral-400 mt-0.5">
                      {ev.startDate ? fmtDateTime(ev.startDate) : "No date"}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold text-neutral-600">
                    {ev.price ? `₹${ev.price}` : "Free"}
                  </span>
                </div>

                {/* Prominent Badge for Events with Pending Payout Confirmation (USER REQUEST) */}
                {ev.hasPendingConfirmation && (
                  <div className="mt-3 rounded-xl bg-amber-500/15 border border-amber-400/50 px-2.5 py-1.5 flex items-center justify-between text-xs text-amber-950 font-bold">
                    <span className="flex items-center gap-1.5">
                      <span className="animate-bounce">🔔</span> Payout Confirmation Pending:
                    </span>
                    <span className="text-amber-900 font-extrabold">
                      {formatCurrency(ev.pendingAmount)}
                    </span>
                  </div>
                )}

                {/* 4 Mini KPIs */}
                <div className="mt-3.5 grid grid-cols-2 gap-2 text-[11px] border-t border-neutral-100 pt-3">
                  <div>
                    <span className="text-neutral-400 block">Gross Sales</span>
                    <span className="font-semibold text-neutral-900">{formatCurrency(ev.gross)}</span>
                  </div>
                  <div>
                    <span className="text-neutral-400 block">Refunds</span>
                    <span className="font-semibold text-neutral-700">-{formatCurrency(ev.refunds)}</span>
                  </div>
                  <div>
                    <span className="text-neutral-400 block">Settled</span>
                    <span className="font-semibold text-emerald-700">{formatCurrency(ev.settled)}</span>
                  </div>
                  <div>
                    <span className="text-neutral-400 block">Remaining Due</span>
                    <span className="font-bold text-cluvo-primary">{formatCurrency(ev.remainingBalance)}</span>
                  </div>
                </div>

                {/* View Details Link */}
                <div className="mt-3 pt-2.5 border-t border-neutral-100 flex items-center justify-between text-xs font-semibold text-cluvo-primary group-hover:translate-x-0.5 transition-transform">
                  <span>View Event Statement</span>
                  <span>→</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Transaction History & Passbook */}
      <div className="rounded-2xl border border-neutral-200/80 bg-white p-5 sm:p-6 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h4 className="font-bold text-neutral-900 text-sm tracking-wide">
              {selectedEventSummary
                ? `Transaction Passbook: ${selectedEventSummary.title}`
                : "All Community Financial Transactions"}
            </h4>
            <p className="text-xs text-neutral-400 mt-0.5">
              Ledger of ticket sales, customer refunds, and manual payout settlements.
            </p>
          </div>

          {/* Filter Pills */}
          <div className="flex flex-wrap items-center gap-1.5">
            {(["all", "credit", "debit", "refund"] as TypeFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setTypeFilter(f)}
                className={`rounded-full px-3 py-1 text-xs font-semibold capitalize transition-all ${
                  typeFilter === f
                    ? "bg-cluvo-primary text-white shadow-xs"
                    : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                }`}
              >
                {f === "all" ? "All Activity" : f === "credit" ? "Ticket Sales (In)" : f === "debit" ? "Payouts (Out)" : "Refunds"}
              </button>
            ))}
          </div>
        </div>

        {/* Transactions Table / Cards */}
        {loading ? (
          <div className="py-8 text-center text-xs text-neutral-400">Loading financial transactions...</div>
        ) : displayedTransactions.length === 0 ? (
          <div className="py-8 text-center text-xs text-neutral-400">
            No transactions match the selected filter.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-neutral-200">
            <table className="w-full text-left text-xs">
              <thead className="bg-neutral-50/80 border-b border-neutral-200 text-neutral-600">
                <tr>
                  <th className="px-4 py-3 font-semibold">Date & Time</th>
                  <th className="px-4 py-3 font-semibold">Description</th>
                  <th className="px-4 py-3 font-semibold">Scope / Event</th>
                  <th className="px-4 py-3 font-semibold text-right">Money In</th>
                  <th className="px-4 py-3 font-semibold text-right">Money Out</th>
                  <th className="px-4 py-3 font-semibold text-center">Status</th>
                  <th className="px-4 py-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {displayedTransactions.map((tx) => {
                  const isPayout = tx.transaction_type.startsWith("payout")
                  const isPendingPayout = isPayout && tx.status === "pending_confirmation"

                  return (
                    <tr
                      key={tx.transaction_id}
                      className={`hover:bg-neutral-50/50 transition-colors ${
                        isPendingPayout ? "bg-amber-50/40" : ""
                      }`}
                    >
                      <td className="px-4 py-3 whitespace-nowrap text-neutral-500 font-medium">
                        {fmtDateTime(tx.created_at)}
                      </td>
                      <td className="px-4 py-3 text-neutral-900 font-medium">
                        <div>{tx.description}</div>
                        {tx.reference_id && (
                          <div className="text-[10px] font-mono text-neutral-400 mt-0.5">
                            Ref: {tx.reference_id}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-neutral-600">
                        {tx.event_title || (tx.event_id ? "Event" : "Entire Wallet")}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-emerald-700">
                        {tx.money_in ? `+${formatCurrency(tx.money_in)}` : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-red-600">
                        {tx.money_out ? `-${formatCurrency(tx.money_out)}` : "—"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            tx.status === "success" || tx.status === "processed"
                              ? "bg-emerald-100 text-emerald-800"
                              : tx.status === "pending_confirmation"
                              ? "bg-amber-100 text-amber-800"
                              : tx.status === "disputed"
                              ? "bg-red-100 text-red-800"
                              : "bg-neutral-100 text-neutral-700"
                          }`}
                        >
                          {tx.status === "pending_confirmation"
                            ? "Action Required"
                            : tx.status === "success"
                            ? "Confirmed"
                            : tx.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {isPendingPayout ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={confirmingPayoutId === tx.transaction_id}
                              onClick={() => handleConfirmPayout(tx.transaction_id, tx.money_out || tx.gross_amount || 0)}
                              className="rounded-lg bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-800 disabled:opacity-50 transition-colors"
                            >
                              {confirmingPayoutId === tx.transaction_id ? "..." : "Confirm"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDisputeTargetPayout(tx)}
                              className="rounded-lg border border-red-300 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50 transition-colors"
                            >
                              Dispute
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setInspectedTx(tx)}
                            className="text-xs font-semibold text-cluvo-primary hover:underline"
                          >
                            Details
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ================= DISPUTE DIALOG MODAL ================= */}
      {disputeTargetPayout && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-2xs"
          onClick={() => !submittingDispute && setDisputeTargetPayout(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-neutral-200 animate-in fade-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-100 pb-3">
              <h4 className="text-base font-bold text-neutral-900">
                Dispute Manual Settlement
              </h4>
              <button
                type="button"
                onClick={() => setDisputeTargetPayout(null)}
                className="rounded-lg p-1 text-neutral-400 hover:text-neutral-700"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleDisputeSubmit} className="mt-4 space-y-4">
              <div className="rounded-xl bg-red-50 p-3 text-xs text-red-800 leading-relaxed border border-red-200">
                ⚠️ If you have not received these funds, or if the amount is incorrect, flag it here.
                The payout will be placed in a <strong>Disputed</strong> status and our finance team will investigate.
              </div>

              <div className="space-y-1 text-xs text-neutral-600 bg-neutral-50 p-3 rounded-xl border border-neutral-200">
                <div className="flex justify-between">
                  <span>Amount:</span>
                  <span className="font-bold text-neutral-900">
                    {formatCurrency(disputeTargetPayout.money_out || disputeTargetPayout.gross_amount || 0)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Reference / UTR:</span>
                  <span className="font-mono text-neutral-800">{disputeTargetPayout.reference_id || "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span>Event:</span>
                  <span className="font-medium text-neutral-800">{disputeTargetPayout.event_title || "Entire Wallet"}</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  Reason for Dispute <span className="text-red-500">*</span>
                </label>
                <textarea
                  required
                  rows={3}
                  value={disputeReason}
                  onChange={(e) => setDisputeReason(e.target.value)}
                  placeholder="e.g. Funds not received in linked bank account; or amount credited does not match recorded figure."
                  className="w-full rounded-lg border border-neutral-300 p-2.5 text-xs text-neutral-900 focus:border-cluvo-primary focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-100">
                <button
                  type="button"
                  onClick={() => setDisputeTargetPayout(null)}
                  disabled={submittingDispute}
                  className="rounded-lg border border-neutral-200 px-4 py-2 text-xs font-semibold text-neutral-700 hover:bg-neutral-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingDispute}
                  className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {submittingDispute ? "Submitting..." : "Submit Dispute"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= TRANSACTION INSPECTION DRAWER/MODAL ================= */}
      {inspectedTx && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-2xs"
          onClick={() => setInspectedTx(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-neutral-200 animate-in fade-in zoom-in-95 duration-150 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-100 pb-3">
              <h4 className="text-base font-bold text-neutral-900">
                Transaction Details
              </h4>
              <button
                type="button"
                onClick={() => setInspectedTx(null)}
                className="rounded-lg p-1 text-neutral-400 hover:text-neutral-700"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2.5 text-xs">
              <div className="flex justify-between py-1 border-b border-neutral-100">
                <span className="text-neutral-400">Type</span>
                <span className="font-semibold capitalize text-neutral-900">{inspectedTx.transaction_type.replace(/_/g, " ")}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-neutral-100">
                <span className="text-neutral-400">Date</span>
                <span className="font-medium text-neutral-800">{fmtDateTime(inspectedTx.created_at)}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-neutral-100">
                <span className="text-neutral-400">Amount</span>
                <span className="font-bold text-neutral-900">
                  {formatCurrency(inspectedTx.money_in || inspectedTx.money_out || inspectedTx.gross_amount || 0)}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-neutral-100">
                <span className="text-neutral-400">Reference</span>
                <span className="font-mono text-neutral-800 select-all">{inspectedTx.reference_id || "—"}</span>
              </div>
              {inspectedTx.event_title && (
                <div className="flex justify-between py-1 border-b border-neutral-100">
                  <span className="text-neutral-400">Event</span>
                  <span className="font-semibold text-neutral-900">{inspectedTx.event_title}</span>
                </div>
              )}
              {inspectedTx.attendee_name && (
                <div className="flex justify-between py-1 border-b border-neutral-100">
                  <span className="text-neutral-400">Attendee / Party</span>
                  <span className="font-medium text-neutral-800">{inspectedTx.attendee_name}</span>
                </div>
              )}
              {inspectedTx.payment_method && (
                <div className="flex justify-between py-1 border-b border-neutral-100">
                  <span className="text-neutral-400">Payment Mode</span>
                  <span className="font-medium text-neutral-800">{inspectedTx.payment_method}</span>
                </div>
              )}
              {inspectedTx.admin_notes && (
                <div className="py-2 bg-neutral-50 rounded-lg p-2.5 text-neutral-700">
                  <span className="font-bold text-neutral-900 block mb-0.5">Admin Note:</span>
                  {inspectedTx.admin_notes}
                </div>
              )}
              {inspectedTx.refund_reason && (
                <div className="py-2 bg-red-50 rounded-lg p-2.5 text-red-900">
                  <span className="font-bold text-red-900 block mb-0.5">Dispute / Reason:</span>
                  {inspectedTx.refund_reason}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setInspectedTx(null)}
              className="w-full rounded-xl bg-neutral-900 py-2.5 text-xs font-semibold text-white hover:bg-neutral-800 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
