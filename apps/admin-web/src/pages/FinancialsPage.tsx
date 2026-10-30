import { useState, useEffect, useMemo, useCallback } from "react"
import { supabase } from "../supabase"
import TransactionDetailDrawer, {
  FinancialTransaction,
  formatCurrency,
  formatDateTime,
} from "../components/TransactionDetailDrawer"
import ManualPayoutModal from "../components/ManualPayoutModal"
import RefundManualReviewModal, { type RefundTaskItem } from "../components/RefundManualReviewModal"

interface CommunityItem {
  id: string
  name: string
  owner_id: string
  wallet_balance?: number
  deleted_at?: string | null
  is_hidden?: boolean | null
}

interface EventItem {
  id: string
  title: string
  start_date: string
  price: number
  status: string
  community_id: string
}

interface BeneficiaryItem {
  id: string
  account_holder: string
  bank_account_number: string
  bank_ifsc: string
  label?: string
  is_active: boolean
}

export interface ReconciliationReport {
  reconciliation_timestamp: string
  summary: {
    total_communities_audited: number
    clean_communities_count: number
    discrepant_communities_count: number
    total_payments_audited: number
    total_refunds_audited: number
    total_payouts_audited: number
    total_discrepancies_found: number
  }
  settlement_overview: {
    gross_revenue_paise: number
    platform_fee_paise: number
    organizer_share_paise: number
    customer_refunds_paise: number
    organizer_refund_debits_paise: number
    confirmed_payouts_paise: number
    pending_payouts_paise: number
    disputed_payouts_paise: number
    total_stored_wallet_paise: number
    total_uncommitted_payable_paise: number
  }
  three_way_wallet_reconciliation: Array<{
    community_id: string
    community_name: string
    stored_wallet_balance: number
    audit_ledger_balance: number
    primary_transaction_balance: number
    in_flight_pending_payouts: number
    disputed_payouts: number
    uncommitted_wallet_balance: number
    status: "CLEAN" | "DISCREPANCY"
    stored_vs_ledger_diff: number
    stored_vs_primary_diff: number
    ledger_vs_primary_diff: number
    discrepancy_types: string[]
    metrics: {
      gross_sales: number
      platform_fees: number
      organizer_sales_earned: number
      customer_refunds: number
      organizer_refund_debits: number
      confirmed_payouts: number
      payment_count: number
      refund_count: number
      payout_count: number
    }
  }>
  payment_discrepancies: Array<{
    payment_id: string
    razorpay_payment_id: string | null
    amount: number
    status: string
    discrepancy_type: string
    discrepancy_details: string
    community_id: string | null
    created_at: string
  }>
  refund_discrepancies: Array<{
    refund_history_id: string
    payment_id: string | null
    razorpay_refund_id: string | null
    amount: number
    discrepancy_type: string
    discrepancy_details: string
    created_at: string
  }>
  settlement_discrepancies: Array<{
    settlement_id: string
    community_id: string
    event_id: string | null
    amount: number
    status: string
    utr: string | null
    discrepancy_type: string
    discrepancy_details: string
    created_at: string
  }>
}

type FilterType = "all" | "ticket_sale" | "refund" | "payout"

export default function FinancialsPage() {
  const [communities, setCommunities] = useState<CommunityItem[]>([])
  const [selectedCommunityId, setSelectedCommunityId] = useState<string>("")
  const [selectedCommunityBalance, setSelectedCommunityBalance] = useState<number>(0)
  const [events, setEvents] = useState<EventItem[]>([])
  const [selectedEventId, setSelectedEventId] = useState<string>("all")
  const [beneficiary, setBeneficiary] = useState<BeneficiaryItem | null>(null)

  const [statement, setStatement] = useState<FinancialTransaction[]>([])
  const [loadingCommunities, setLoadingCommunities] = useState<boolean>(true)
  const [loadingStatement, setLoadingStatement] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // Filters & Search
  const [filterType, setFilterType] = useState<FilterType>("all")
  const [searchQuery, setSearchQuery] = useState<string>("")

  // Modal and Drawer State
  const [inspectedTx, setInspectedTx] = useState<FinancialTransaction | null>(null)
  const [isPayoutModalOpen, setIsPayoutModalOpen] = useState<boolean>(false)
  const [payoutModalEventId, setPayoutModalEventId] = useState<string | null>(null)
  const [payoutModalAmount, setPayoutModalAmount] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // Unresolved Refund Queue Tasks (Milestone B)
  const [unresolvedTasks, setUnresolvedTasks] = useState<RefundTaskItem[]>([])
  const [showUnresolvedPanel, setShowUnresolvedPanel] = useState<boolean>(false)
  const [selectedTaskForReview, setSelectedTaskForReview] = useState<RefundTaskItem | null>(null)

  // Financial Reconciliation Engine State (Stage 5 Milestone D)
  const [reconReport, setReconReport] = useState<ReconciliationReport | null>(null)
  const [loadingRecon, setLoadingRecon] = useState<boolean>(false)
  const [showReconPanel, setShowReconPanel] = useState<boolean>(false)
  const [reconActiveTab, setReconActiveTab] = useState<"wallets" | "payments" | "refunds" | "settlements">("wallets")

  const runReconciliation = useCallback(async () => {
    setLoadingRecon(true)
    try {
      const { data, error: rpcErr } = await supabase.rpc("run_financial_reconciliation", {
        p_community_id: null,
        p_batch_limit: 1000,
      })
      if (rpcErr) throw rpcErr
      setReconReport(data as ReconciliationReport)
    } catch (err: any) {
      console.error("Reconciliation run failed:", err)
      setError(err?.message || "Failed to execute financial reconciliation.")
    } finally {
      setLoadingRecon(false)
    }
  }, [])

  // 1. Initial Load: Fetch all communities (Admin RPC with whitelisted fallback)
  useEffect(() => {
    let isMounted = true
    const loadCommunities = async () => {
      setLoadingCommunities(true)
      try {
        // Try dedicated admin RPC first
        const { data: rpcData, error: rpcErr } = await supabase.rpc("get_admin_communities")
        if (!rpcErr && rpcData && Array.isArray(rpcData) && rpcData.length > 0) {
          if (isMounted) {
            setCommunities(rpcData as CommunityItem[])
            setSelectedCommunityId(rpcData[0].id)
            setSelectedCommunityBalance(rpcData[0].wallet_balance ?? 0)
          }
          return
        }

        // Fallback: Query allowed columns directly from communities
        const { data, error } = await supabase
          .from("communities")
          .select("id, name, owner_id")
          .order("name", { ascending: true })

        if (error) throw error

        if (isMounted && data && data.length > 0) {
          const commList = (data as any[]).map((c) => ({
            id: c.id,
            name: c.name,
            owner_id: c.owner_id,
            wallet_balance: 0,
          }))
          setCommunities(commList)
          setSelectedCommunityId(commList[0].id)
        }
      } catch (err: any) {
        if (isMounted) setError(err.message || "Failed to load communities.")
      } finally {
        if (isMounted) setLoadingCommunities(false)
      }
    }

    loadCommunities()
    return () => {
      isMounted = false
    }
  }, [])

  // 2. When selected community changes: Load its events, active beneficiary, and exact wallet balance
  useEffect(() => {
    if (!selectedCommunityId) {
      setEvents([])
      setBeneficiary(null)
      return
    }

    let isMounted = true

    const loadCommunityMeta = async () => {
      try {
        const [eventsRes, benRes, finRes] = await Promise.all([
          supabase
            .from("events")
            .select("id, title, start_date, price, status, community_id")
            .eq("community_id", selectedCommunityId)
            .is("deleted_at", null)
            .order("start_date", { ascending: false }),
          supabase
            .from("community_beneficiaries")
            .select("*")
            .eq("community_id", selectedCommunityId)
            .eq("is_active", true)
            .maybeSingle(),
          supabase.rpc("get_community_financials", { p_community_id: selectedCommunityId }),
        ])

        if (isMounted) {
          setEvents((eventsRes.data as EventItem[]) || [])
          setSelectedEventId("all")
          setBeneficiary((benRes.data as BeneficiaryItem) || null)

          if (finRes.data?.[0]) {
            const bal = finRes.data[0].wallet_balance ?? 0
            setSelectedCommunityBalance(bal)
            setCommunities((prev) =>
              prev.map((c) => (c.id === selectedCommunityId ? { ...c, wallet_balance: bal } : c))
            )
          }
        }
      } catch (err: any) {
        console.error("Error loading community meta:", err)
      }
    }

    loadCommunityMeta()
    return () => {
      isMounted = false
    }
  }, [selectedCommunityId])

  // 3. Load Statement via RPC
  const loadStatement = useCallback(async () => {
    if (!selectedCommunityId) return

    setLoadingStatement(true)
    setError(null)

    try {
      const eventParam = selectedEventId === "all" ? null : selectedEventId
      const { data, error: rpcErr } = await supabase.rpc("get_admin_financial_statement", {
        p_community_id: selectedCommunityId,
        p_event_id: eventParam,
      })

      if (rpcErr) throw rpcErr

      setStatement((data as FinancialTransaction[]) || [])
    } catch (err: any) {
      console.error("Error loading financial statement:", err)
      setError(err.message || "Failed to load financial statement.")
      setStatement([])
    } finally {
      setLoadingStatement(false)
    }
  }, [selectedCommunityId, selectedEventId])

  const loadUnresolvedTasks = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("refund_task_queue")
        .select("*, events(title)")
        .in("status", ["manual_review", "uncertain"])
        .order("created_at", { ascending: false })

      if (!error && data) {
        setUnresolvedTasks(
          (data as any[]).map((t) => ({
            ...t,
            event_title: t.events?.title,
          }))
        )
      }
    } catch (err) {
      console.error("Error loading unresolved refund tasks:", err)
    }
  }, [])

  useEffect(() => {
    loadStatement()
    loadUnresolvedTasks()
  }, [loadStatement, loadUnresolvedTasks])

  // 4. Calculate Financial KPIs from Statement
  const kpis = useMemo(() => {
    let grossRevenue = 0
    let platformFees = 0
    let refundsDeducted = 0
    let payoutsSettled = 0
    let payoutsPending = 0
    let payoutsDisputed = 0

    for (const tx of statement) {
      if (tx.transaction_type === "ticket_sale") {
        grossRevenue += tx.gross_amount || 0
        platformFees += tx.platform_fee || 0
      } else if (tx.transaction_type === "refund") {
        refundsDeducted += tx.money_out || 0
      } else if (tx.transaction_type.startsWith("payout")) {
        if (tx.status === "success" || tx.status === "processed") {
          payoutsSettled += tx.money_out || 0
        } else if (tx.status === "disputed") {
          payoutsDisputed += tx.money_out || 0
        } else {
          payoutsPending += tx.money_out || 0
        }
      }
    }

    const activeComm = communities.find((c) => c.id === selectedCommunityId)
    const walletBalance = selectedCommunityBalance || (activeComm?.wallet_balance ?? 0)
    const uncommittedPayable = Math.max(0, walletBalance - payoutsPending - payoutsDisputed)

    return {
      grossRevenue,
      platformFees,
      refundsDeducted,
      payoutsSettled,
      payoutsPending,
      payoutsDisputed,
      walletBalance,
      uncommittedPayable,
      netCredited: grossRevenue - platformFees - refundsDeducted,
    }
  }, [statement, communities, selectedCommunityId, selectedCommunityBalance])

  // 5. Event-Wise Aggregations (computed across events and transactions)
  const eventBreakdownList = useMemo(() => {
    if (events.length === 0) return []

    // Group transactions by event_id
    const txByEvent = new Map<string, FinancialTransaction[]>()
    for (const tx of statement) {
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
      let pending = 0
      let disputed = 0

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
            pending += tx.money_out || 0
          } else if (tx.status === "disputed") {
            disputed += tx.money_out || 0
          }
        }
      }

      const netOrganizerTotal = Math.max(0, gross - platformFee - refunds)
      const remainingBalance = Math.max(0, netOrganizerTotal - settled - pending - disputed)

      let settlementStatus: "fully_settled" | "pending_confirmation" | "partially_settled" | "unsettled" | "no_sales" = "unsettled"
      if (gross === 0 && refunds === 0 && settled === 0) {
        settlementStatus = "no_sales"
      } else if (remainingBalance === 0 && (settled > 0 || netOrganizerTotal === 0)) {
        settlementStatus = "fully_settled"
      } else if (pending > 0) {
        settlementStatus = "pending_confirmation"
      } else if (settled > 0 && remainingBalance > 0) {
        settlementStatus = "partially_settled"
      } else {
        settlementStatus = "unsettled"
      }

      return {
        id: ev.id,
        title: ev.title,
        startDate: ev.start_date,
        price: ev.price,
        eventStatus: ev.status,
        gross,
        platformFee,
        refunds,
        netOrganizerTotal,
        settled,
        pending,
        disputed,
        remainingBalance,
        settlementStatus,
        txCount: eventTxs.length,
      }
    })
  }, [events, statement])

  // Single Selected Event Item & Metrics
  const selectedEventItem = useMemo(() => {
    if (selectedEventId === "all") return null
    return events.find((e) => e.id === selectedEventId) || null
  }, [events, selectedEventId])

  const selectedEventSummary = useMemo(() => {
    if (!selectedEventItem) return null
    const matched = eventBreakdownList.find((b) => b.id === selectedEventItem.id)
    if (matched && matched.gross > 0) return matched

    const gross = kpis.grossRevenue
    const platformFee = kpis.platformFees
    const refunds = kpis.refundsDeducted
    const netOrganizerTotal = Math.max(0, gross - platformFee - refunds)
    const settled = kpis.payoutsSettled
    const pending = kpis.payoutsPending
    const disputed = kpis.payoutsDisputed
    const remainingBalance = Math.max(0, netOrganizerTotal - settled - pending - disputed)

    let settlementStatus: "fully_settled" | "pending_confirmation" | "partially_settled" | "unsettled" | "no_sales" = "unsettled"
    if (gross === 0 && refunds === 0 && settled === 0) {
      settlementStatus = "no_sales"
    } else if (remainingBalance === 0 && (settled > 0 || netOrganizerTotal === 0)) {
      settlementStatus = "fully_settled"
    } else if (pending > 0) {
      settlementStatus = "pending_confirmation"
    } else if (settled > 0 && remainingBalance > 0) {
      settlementStatus = "partially_settled"
    } else {
      settlementStatus = "unsettled"
    }

    return {
      id: selectedEventItem.id,
      title: selectedEventItem.title,
      startDate: selectedEventItem.start_date,
      price: selectedEventItem.price,
      eventStatus: selectedEventItem.status,
      gross,
      platformFee,
      refunds,
      netOrganizerTotal,
      settled,
      pending,
      remainingBalance,
      settlementStatus,
      txCount: statement.length,
    }
  }, [selectedEventItem, eventBreakdownList, kpis, statement.length])

  // 6. Client Filtering & Searching
  const filteredStatement = useMemo(() => {
    return statement.filter((tx) => {
      // Type filter
      if (filterType === "ticket_sale" && tx.transaction_type !== "ticket_sale") return false
      if (filterType === "refund" && tx.transaction_type !== "refund") return false
      if (filterType === "payout" && !tx.transaction_type.startsWith("payout")) return false

      // Search Query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim()
        const matchName = tx.attendee_name?.toLowerCase().includes(q)
        const matchEmail = tx.attendee_email?.toLowerCase().includes(q)
        const matchRef = tx.reference_id?.toLowerCase().includes(q)
        const matchSecRef = tx.secondary_ref?.toLowerCase().includes(q)
        const matchDesc = tx.description?.toLowerCase().includes(q)
        const matchEvent = tx.event_title?.toLowerCase().includes(q)
        const matchNotes = tx.admin_notes?.toLowerCase().includes(q)
        return (
          matchName ||
          matchEmail ||
          matchRef ||
          matchSecRef ||
          matchDesc ||
          matchEvent ||
          matchNotes
        )
      }

      return true
    })
  }, [statement, filterType, searchQuery])

  // Copy helper
  const copyText = (text: string, key: string) => {
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr))
    }, 1500)
  }

  // 6. CSV Export Helper
  const exportToCsv = () => {
    if (!filteredStatement.length) return

    const selectedComm = communities.find((c) => c.id === selectedCommunityId)
    const commName = selectedComm ? selectedComm.name.replace(/[^a-z0-9]/gi, "_") : "community"
    const eventName = selectedEventId !== "all"
      ? (events.find((e) => e.id === selectedEventId)?.title || "event").replace(/[^a-z0-9]/gi, "_")
      : "all_events"
    const filename = `cluvo_ledger_${commName}_${eventName}_${new Date().toISOString().slice(0, 10)}.csv`

    const headers = [
      "Timestamp (IST)",
      "Transaction ID",
      "Type",
      "Status",
      "Description",
      "Event Title",
      "Attendee / Beneficiary",
      "Attendee Email",
      "Attendee Phone",
      "Razorpay / Bank Ref (UTR)",
      "Secondary Ref (Order ID)",
      "Gross Amount (INR)",
      "Platform Fee 6% (INR)",
      "Money In (INR)",
      "Money Out (INR)",
      "Running Balance (INR)",
      "Refund Reason",
      "Admin Notes",
    ]

    const rows = filteredStatement.map((tx) => [
      `"${formatDateTime(tx.created_at)}"`,
      `"${tx.transaction_id}"`,
      `"${tx.transaction_type}"`,
      `"${tx.status}"`,
      `"${(tx.description || "").replace(/"/g, '""')}"`,
      `"${(tx.event_title || "").replace(/"/g, '""')}"`,
      `"${(tx.attendee_name || "").replace(/"/g, '""')}"`,
      `"${tx.attendee_email || ""}"`,
      `"${tx.attendee_phone || ""}"`,
      `"${tx.reference_id || ""}"`,
      `"${tx.secondary_ref || ""}"`,
      (tx.gross_amount / 100).toFixed(2),
      (tx.platform_fee / 100).toFixed(2),
      (tx.money_in / 100).toFixed(2),
      (tx.money_out / 100).toFixed(2),
      (tx.running_balance / 100).toFixed(2),
      `"${(tx.refund_reason || "").replace(/"/g, '""')}"`,
      `"${(tx.admin_notes || "").replace(/"/g, '""')}"`,
    ])

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n")
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" })
    const link = document.createElement("a")
    const url = URL.createObjectURL(blob)
    link.setAttribute("href", url)
    link.setAttribute("download", filename)
    link.style.visibility = "hidden"
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const rawCommunity = communities.find((c) => c.id === selectedCommunityId) || null
  const selectedCommunity = rawCommunity
    ? { ...rawCommunity, wallet_balance: selectedCommunityBalance || (rawCommunity.wallet_balance ?? 0) }
    : null

  if (loadingCommunities) {
    return (
      <div className="flex items-center justify-center py-24">
        <svg className="h-8 w-8 animate-spin text-cluvo-primary" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-neutral-900">
              Financials & Event Passbook
            </h1>
            <span className="inline-flex items-center rounded-md bg-pink-50 px-2 py-1 text-xs font-semibold text-cluvo-primary ring-1 ring-inset ring-pink-700/10">
              Razorpay Ground Truth
            </span>
          </div>
          <p className="mt-1 text-sm text-neutral-500">
            Bank-grade financial ledger auditing ticket sales, 6% platform fees, customer refunds, and organizer payouts.
          </p>
        </div>

        {/* Global Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={loadStatement}
            disabled={loadingStatement}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold text-neutral-700 shadow-xs hover:bg-neutral-50 transition-colors"
            title="Reload Passbook"
          >
            <svg
              className={`h-4 w-4 text-neutral-500 ${loadingStatement ? "animate-spin" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>

          <button
            onClick={exportToCsv}
            disabled={!filteredStatement.length}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold text-neutral-700 shadow-xs hover:bg-neutral-50 disabled:opacity-40 transition-colors"
            title="Download CSV Statement"
          >
            <svg className="h-4 w-4 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export CSV
          </button>

          <button
            onClick={() => {
              const nextShow = !showReconPanel
              setShowReconPanel(nextShow)
              if (nextShow && !reconReport) {
                runReconciliation()
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-purple-300 bg-purple-50 px-3 py-2 text-xs font-semibold text-purple-700 shadow-xs hover:bg-purple-100 transition-colors"
            title="3-Way Financial Reconciliation Engine"
          >
            <span className="text-purple-600">⚖️</span>
            {showReconPanel ? "Hide Reconciliation" : "Reconciliation Audit"}
          </button>

          <button
            onClick={() => {
              setPayoutModalEventId(selectedEventId === "all" ? null : selectedEventId)
              setPayoutModalAmount(selectedEventSummary && selectedEventSummary.remainingBalance > 0 ? (selectedEventSummary.remainingBalance / 100).toFixed(2) : "")
              setIsPayoutModalOpen(true)
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-cluvo-primary px-3.5 py-2 text-xs font-semibold text-white shadow-xs hover:bg-cluvo-primary/90 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Record Manual Payout
          </button>
        </div>
      </div>

      {/* Unresolved Refund Tasks Alert Banner (Milestone B) */}
      {unresolvedTasks.length > 0 && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50/80 p-4 text-xs text-rose-900 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-rose-200 text-rose-800 font-bold text-base">
                ⚠️
              </span>
              <div>
                <h4 className="text-sm font-bold text-rose-950">
                  {unresolvedTasks.length} Refund {unresolvedTasks.length === 1 ? "Task Requires" : "Tasks Require"} Manual Review
                </h4>
                <p className="text-[11px] text-rose-700">
                  Cancellation queue tasks flagged with provider timeouts, 409 conflicts, or exhausted retries requiring admin reconciliation.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowUnresolvedPanel(!showUnresolvedPanel)}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-700 shadow-2xs transition-colors"
              >
                {showUnresolvedPanel ? "Hide Tasks" : `Review Tasks (${unresolvedTasks.length})`}
              </button>
            </div>
          </div>

          {showUnresolvedPanel && (
            <div className="mt-3 overflow-x-auto rounded-xl border border-rose-200 bg-white">
              <table className="w-full text-left text-xs">
                <thead className="bg-rose-50/60 border-b border-rose-100 font-bold text-rose-900 uppercase">
                  <tr>
                    <th className="px-3 py-2">Event</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2 text-center">Status</th>
                    <th className="px-3 py-2 text-center">Attempts</th>
                    <th className="px-3 py-2">Last Reason</th>
                    <th className="px-3 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {unresolvedTasks.map((task) => (
                    <tr key={task.id} className="hover:bg-neutral-50 transition-colors">
                      <td className="px-3 py-2.5 font-semibold text-neutral-800">
                        {task.event_title || task.event_id.slice(0, 8)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-bold text-rose-600 whitespace-nowrap">
                        {formatCurrency(task.amount)}
                      </td>
                      <td className="px-3 py-2.5 text-center whitespace-nowrap">
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-800 uppercase">
                          {task.status.replace("_", " ")}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-center text-neutral-600 font-mono">
                        {task.attempt_count} / {task.max_attempts}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[10px] text-neutral-500 truncate max-w-[200px]" title={task.error_message || ""}>
                        {task.error_message || "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <button
                          onClick={() => setSelectedTaskForReview(task)}
                          className="rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-rose-700 shadow-2xs"
                        >
                          Resolve
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Financial Health & Observability Panel (Stage 5 Milestone D) */}
      {showReconPanel && (
        <div className="rounded-2xl border border-purple-200 bg-white p-6 shadow-xs space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-purple-100 pb-4">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-100 text-purple-700 font-bold text-lg">
                ⚖️
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-neutral-900">
                    3-Way Financial Reconciliation Engine
                  </h3>
                  {reconReport && (
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        reconReport.summary.total_discrepancies_found === 0
                          ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20"
                          : "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          reconReport.summary.total_discrepancies_found === 0
                            ? "bg-emerald-600 animate-pulse"
                            : "bg-amber-600"
                        }`}
                      />
                      {reconReport.summary.total_discrepancies_found === 0
                        ? "100% CLEAN"
                        : `${reconReport.summary.total_discrepancies_found} Discrepancies`}
                    </span>
                  )}
                </div>
                <p className="text-xs text-neutral-500 mt-0.5">
                  Three-way audit: Stored Community Wallet vs Audit Log Ledger vs Primary Transactions.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={runReconciliation}
                disabled={loadingRecon}
                className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3.5 py-2 text-xs font-semibold text-white shadow-xs hover:bg-purple-700 disabled:opacity-50 transition-colors"
              >
                <svg
                  className={`h-4 w-4 ${loadingRecon ? "animate-spin" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {loadingRecon ? "Auditing Database..." : "Rerun Reconciliation"}
              </button>
            </div>
          </div>

          {loadingRecon ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex items-center gap-3 text-purple-700 font-semibold text-sm">
                <svg className="h-6 w-6 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Running live 3-way balance audit across all communities and transactions...
              </div>
            </div>
          ) : reconReport ? (
            <>
              {/* Summary Metrics Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                <div className="rounded-xl border border-neutral-100 bg-neutral-50/50 p-3">
                  <span className="block text-[11px] font-bold uppercase tracking-wider text-neutral-400">
                    Gross Revenue
                  </span>
                  <div className="mt-1 text-sm font-extrabold text-neutral-900">
                    {formatCurrency(reconReport.settlement_overview.gross_revenue_paise)}
                  </div>
                  <span className="text-[10px] text-neutral-500">Total customer sales</span>
                </div>

                <div className="rounded-xl border border-neutral-100 bg-neutral-50/50 p-3">
                  <span className="block text-[11px] font-bold uppercase tracking-wider text-neutral-400">
                    Platform Fees (6%)
                  </span>
                  <div className="mt-1 text-sm font-extrabold text-cluvo-primary">
                    {formatCurrency(reconReport.settlement_overview.platform_fee_paise)}
                  </div>
                  <span className="text-[10px] text-neutral-500">Platform earnings</span>
                </div>

                <div className="rounded-xl border border-neutral-100 bg-neutral-50/50 p-3">
                  <span className="block text-[11px] font-bold uppercase tracking-wider text-neutral-400">
                    Customer Refunds
                  </span>
                  <div className="mt-1 text-sm font-extrabold text-rose-600">
                    {formatCurrency(reconReport.settlement_overview.customer_refunds_paise)}
                  </div>
                  <span className="text-[10px] text-neutral-500">Gross refunds paid</span>
                </div>

                <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3">
                  <span className="block text-[11px] font-bold uppercase tracking-wider text-emerald-800">
                    Confirmed Payouts
                  </span>
                  <div className="mt-1 text-sm font-extrabold text-emerald-700">
                    {formatCurrency(reconReport.settlement_overview.confirmed_payouts_paise)}
                  </div>
                  <span className="text-[10px] text-emerald-600">Organizer accepted</span>
                </div>

                <div className="rounded-xl border border-amber-100 bg-amber-50/40 p-3">
                  <span className="block text-[11px] font-bold uppercase tracking-wider text-amber-800">
                    Pending Payouts
                  </span>
                  <div className="mt-1 text-sm font-extrabold text-amber-700">
                    {formatCurrency(reconReport.settlement_overview.pending_payouts_paise)}
                  </div>
                  <span className="text-[10px] text-amber-600">In-flight transfers</span>
                </div>

                <div className="rounded-xl border border-rose-100 bg-rose-50/40 p-3">
                  <span className="block text-[11px] font-bold uppercase tracking-wider text-rose-800">
                    Disputed Payouts
                  </span>
                  <div className="mt-1 text-sm font-extrabold text-rose-700">
                    {formatCurrency(reconReport.settlement_overview.disputed_payouts_paise)}
                  </div>
                  <span className="text-[10px] text-rose-600">Organizer rejected</span>
                </div>

                <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-3 col-span-2 sm:col-span-1">
                  <span className="block text-[11px] font-bold uppercase tracking-wider text-indigo-800">
                    Uncommitted Payable
                  </span>
                  <div className="mt-1 text-sm font-extrabold text-indigo-700">
                    {formatCurrency(reconReport.settlement_overview.total_uncommitted_payable_paise)}
                  </div>
                  <span className="text-[10px] text-indigo-600">Free wallet liability</span>
                </div>
              </div>

              {/* Sub-Tabs for Mismatch Explorer */}
              <div className="border-b border-neutral-200">
                <nav className="-mb-px flex space-x-6 text-xs font-semibold">
                  <button
                    onClick={() => setReconActiveTab("wallets")}
                    className={`pb-2.5 border-b-2 transition-colors ${
                      reconActiveTab === "wallets"
                        ? "border-purple-600 text-purple-700"
                        : "border-transparent text-neutral-500 hover:text-neutral-700 hover:border-neutral-300"
                    }`}
                  >
                    Three-Way Wallet Reconciliation ({reconReport.three_way_wallet_reconciliation.length})
                  </button>

                  <button
                    onClick={() => setReconActiveTab("payments")}
                    className={`pb-2.5 border-b-2 transition-colors ${
                      reconActiveTab === "payments"
                        ? "border-purple-600 text-purple-700"
                        : "border-transparent text-neutral-500 hover:text-neutral-700 hover:border-neutral-300"
                    }`}
                  >
                    Payment Discrepancies ({reconReport.payment_discrepancies.length})
                  </button>

                  <button
                    onClick={() => setReconActiveTab("refunds")}
                    className={`pb-2.5 border-b-2 transition-colors ${
                      reconActiveTab === "refunds"
                        ? "border-purple-600 text-purple-700"
                        : "border-transparent text-neutral-500 hover:text-neutral-700 hover:border-neutral-300"
                    }`}
                  >
                    Refund Discrepancies ({reconReport.refund_discrepancies.length})
                  </button>

                  <button
                    onClick={() => setReconActiveTab("settlements")}
                    className={`pb-2.5 border-b-2 transition-colors ${
                      reconActiveTab === "settlements"
                        ? "border-purple-600 text-purple-700"
                        : "border-transparent text-neutral-500 hover:text-neutral-700 hover:border-neutral-300"
                    }`}
                  >
                    Settlement Discrepancies ({reconReport.settlement_discrepancies.length})
                  </button>
                </nav>
              </div>

              {/* Tab 1: Three-Way Wallet Balances */}
              {reconActiveTab === "wallets" && (
                <div className="overflow-x-auto rounded-xl border border-neutral-200">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-neutral-50/80 border-b border-neutral-200 font-bold text-neutral-700 uppercase">
                      <tr>
                        <th className="px-3 py-2.5">Community</th>
                        <th className="px-3 py-2.5 text-right">Stored Wallet</th>
                        <th className="px-3 py-2.5 text-right">Audit Ledger</th>
                        <th className="px-3 py-2.5 text-right">Primary Transactions</th>
                        <th className="px-3 py-2.5 text-right">In-Flight Pending</th>
                        <th className="px-3 py-2.5 text-right">Uncommitted</th>
                        <th className="px-3 py-2.5 text-center">Status</th>
                        <th className="px-3 py-2.5">Findings</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {reconReport.three_way_wallet_reconciliation.map((comm) => (
                        <tr key={comm.community_id} className="hover:bg-neutral-50/50 transition-colors">
                          <td className="px-3 py-2.5 font-semibold text-neutral-900">
                            {comm.community_name}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono font-bold text-neutral-900">
                            {formatCurrency(comm.stored_wallet_balance)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-neutral-700">
                            {formatCurrency(comm.audit_ledger_balance)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-neutral-700">
                            {formatCurrency(comm.primary_transaction_balance)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-amber-700">
                            {formatCurrency(comm.in_flight_pending_payouts)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono font-bold text-emerald-700">
                            {formatCurrency(comm.uncommitted_wallet_balance)}
                          </td>
                          <td className="px-3 py-2.5 text-center whitespace-nowrap">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                                comm.status === "CLEAN"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : "bg-amber-100 text-amber-800"
                              }`}
                            >
                              {comm.status}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-neutral-600 text-[11px]">
                            {comm.discrepancy_types && comm.discrepancy_types.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {comm.discrepancy_types.map((type) => (
                                  <span key={type} className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-800 border border-amber-200">
                                    {type}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-emerald-700 font-semibold">Exact 0 paise diff</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Tab 2: Payment Discrepancies */}
              {reconActiveTab === "payments" && (
                <div className="overflow-x-auto rounded-xl border border-neutral-200">
                  {reconReport.payment_discrepancies.length === 0 ? (
                    <div className="py-8 text-center text-xs text-neutral-500">
                      ✓ Zero payment discrepancies found across all transactions.
                    </div>
                  ) : (
                    <table className="w-full text-left text-xs">
                      <thead className="bg-neutral-50/80 border-b border-neutral-200 font-bold text-neutral-700 uppercase">
                        <tr>
                          <th className="px-3 py-2.5">Type</th>
                          <th className="px-3 py-2.5">Payment ID / Ref</th>
                          <th className="px-3 py-2.5 text-right">Amount</th>
                          <th className="px-3 py-2.5">Status</th>
                          <th className="px-3 py-2.5">Details</th>
                          <th className="px-3 py-2.5">Date</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100">
                        {reconReport.payment_discrepancies.map((p, idx) => (
                          <tr key={`${p.payment_id}-${idx}`} className="hover:bg-neutral-50/50 transition-colors">
                            <td className="px-3 py-2.5 font-mono font-bold text-amber-800">
                              {p.discrepancy_type}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[11px] text-neutral-700">
                              {p.razorpay_payment_id || p.payment_id.slice(0, 8)}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-neutral-900">
                              {formatCurrency(p.amount)}
                            </td>
                            <td className="px-3 py-2.5 text-neutral-600">
                              {p.status}
                            </td>
                            <td className="px-3 py-2.5 text-neutral-600 text-[11px]">
                              {p.discrepancy_details}
                            </td>
                            <td className="px-3 py-2.5 text-neutral-500 whitespace-nowrap">
                              {formatDateTime(p.created_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* Tab 3: Refund Discrepancies */}
              {reconActiveTab === "refunds" && (
                <div className="overflow-x-auto rounded-xl border border-neutral-200">
                  {reconReport.refund_discrepancies.length === 0 ? (
                    <div className="py-8 text-center text-xs text-neutral-500">
                      ✓ Zero refund discrepancies found across all refund records and queue tasks.
                    </div>
                  ) : (
                    <table className="w-full text-left text-xs">
                      <thead className="bg-neutral-50/80 border-b border-neutral-200 font-bold text-neutral-700 uppercase">
                        <tr>
                          <th className="px-3 py-2.5">Type</th>
                          <th className="px-3 py-2.5">Refund / Task ID</th>
                          <th className="px-3 py-2.5 text-right">Amount</th>
                          <th className="px-3 py-2.5">Details</th>
                          <th className="px-3 py-2.5">Date</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100">
                        {reconReport.refund_discrepancies.map((r, idx) => (
                          <tr key={`${r.refund_history_id}-${idx}`} className="hover:bg-neutral-50/50 transition-colors">
                            <td className="px-3 py-2.5 font-mono font-bold text-rose-800">
                              {r.discrepancy_type}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[11px] text-neutral-700">
                              {r.razorpay_refund_id || r.refund_history_id.slice(0, 8)}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-rose-700">
                              {formatCurrency(r.amount)}
                            </td>
                            <td className="px-3 py-2.5 text-neutral-600 text-[11px]">
                              {r.discrepancy_details}
                            </td>
                            <td className="px-3 py-2.5 text-neutral-500 whitespace-nowrap">
                              {formatDateTime(r.created_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* Tab 4: Settlement Discrepancies */}
              {reconActiveTab === "settlements" && (
                <div className="overflow-x-auto rounded-xl border border-neutral-200">
                  {reconReport.settlement_discrepancies.length === 0 ? (
                    <div className="py-8 text-center text-xs text-neutral-500">
                      ✓ Zero settlement discrepancies found across payouts and UTR records.
                    </div>
                  ) : (
                    <table className="w-full text-left text-xs">
                      <thead className="bg-neutral-50/80 border-b border-neutral-200 font-bold text-neutral-700 uppercase">
                        <tr>
                          <th className="px-3 py-2.5">Type</th>
                          <th className="px-3 py-2.5">Settlement ID</th>
                          <th className="px-3 py-2.5">UTR</th>
                          <th className="px-3 py-2.5 text-right">Amount</th>
                          <th className="px-3 py-2.5">Status</th>
                          <th className="px-3 py-2.5">Details</th>
                          <th className="px-3 py-2.5">Date</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100">
                        {reconReport.settlement_discrepancies.map((s, idx) => (
                          <tr key={`${s.settlement_id}-${idx}`} className="hover:bg-neutral-50/50 transition-colors">
                            <td className="px-3 py-2.5 font-mono font-bold text-amber-800">
                              {s.discrepancy_type}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[11px] text-neutral-700">
                              {s.settlement_id.slice(0, 8)}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[11px] text-neutral-700">
                              {s.utr || "—"}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-neutral-900">
                              {formatCurrency(s.amount)}
                            </td>
                            <td className="px-3 py-2.5 text-neutral-600">
                              {s.status}
                            </td>
                            <td className="px-3 py-2.5 text-neutral-600 text-[11px]">
                              {s.discrepancy_details}
                            </td>
                            <td className="px-3 py-2.5 text-neutral-500 whitespace-nowrap">
                              {formatDateTime(s.created_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* Selectors Card (Community & Event Cascading Dropdown) */}
      <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-xs">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Community Dropdown */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-neutral-500 mb-1.5">
              1. Select Community
            </label>
            <select
              value={selectedCommunityId}
              onChange={(e) => setSelectedCommunityId(e.target.value)}
              className="w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-neutral-900 shadow-xs focus:border-cluvo-primary focus:outline-none focus:ring-1 focus:ring-cluvo-primary"
            >
              {communities.map((comm) => (
                <option key={comm.id} value={comm.id}>
                  {comm.name}
                  {comm.wallet_balance !== undefined ? ` — Balance: ${formatCurrency(comm.wallet_balance)}` : ""}
                  {comm.deleted_at ? " (Closed)" : comm.is_hidden ? " (Hidden)" : ""}
                </option>
              ))}
              {communities.length === 0 && (
                <option value="">No communities found</option>
              )}
            </select>
            {selectedCommunity && (
              <p className="mt-1 text-xs text-neutral-500 flex items-center gap-1">
                <span>Total Community Wallet:</span>
                <span className="font-bold text-emerald-700">
                  {formatCurrency(selectedCommunity.wallet_balance)}
                </span>
              </p>
            )}
          </div>

          {/* Event Dropdown */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-neutral-500 mb-1.5">
              2. Filter by Event
            </label>
            <select
              value={selectedEventId}
              onChange={(e) => setSelectedEventId(e.target.value)}
              className="w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-neutral-900 shadow-xs focus:border-cluvo-primary focus:outline-none focus:ring-1 focus:ring-cluvo-primary"
            >
              <option value="all">🌟 All Events (Entire Community Statement)</option>
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.title} (₹{ev.price / 100})
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-neutral-500">
              {selectedEventId === "all"
                ? `Showing consolidated activity across ${events.length} events.`
                : `Filtered strictly to selected event.`}
            </p>
          </div>

          {/* Verified Beneficiary Account Snapshot */}
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/70 p-3 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-neutral-400">
                  Beneficiary Bank Account
                </span>
                {beneficiary ? (
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-600"></span>
                    Verified
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                    Not Linked
                  </span>
                )}
              </div>
              {beneficiary ? (
                <div className="mt-1.5">
                  <p className="font-bold text-neutral-900 text-xs truncate">
                    {beneficiary.account_holder}
                  </p>
                  <p className="text-[11px] font-mono text-neutral-600 mt-0.5">
                    A/C: {beneficiary.bank_account_number} • IFSC: {beneficiary.bank_ifsc}
                  </p>
                </div>
              ) : (
                <p className="text-[11px] text-amber-700 mt-1">
                  Organizer has not yet added an active bank account.
                </p>
              )}
            </div>
            {beneficiary?.label && (
              <span className="text-[10px] text-neutral-400 mt-1">
                Label: {beneficiary.label}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Selected Event Financial Statement Banner OR Community Overview */}
      {selectedEventId !== "all" && selectedEventSummary ? (
        <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-xs">
          {/* Header row */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-neutral-100">
            <div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSelectedEventId("all")}
                  className="text-xs font-bold text-cluvo-primary hover:underline flex items-center gap-1"
                >
                  ← Back to All Events
                </button>
                <span className="text-neutral-300">•</span>
                <span className="text-xs uppercase font-bold tracking-wider text-neutral-400">
                  Event Financial Statement
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                <h4 className="text-xl font-black text-neutral-900">
                  {selectedEventSummary.title}
                </h4>
                <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full ${
                  selectedEventSummary.settlementStatus === "fully_settled" ? "bg-emerald-100 text-emerald-800" :
                  selectedEventSummary.settlementStatus === "pending_confirmation" ? "bg-amber-100 text-amber-800" :
                  selectedEventSummary.settlementStatus === "partially_settled" ? "bg-blue-100 text-blue-800" :
                  selectedEventSummary.settlementStatus === "no_sales" ? "bg-neutral-100 text-neutral-600" :
                  "bg-rose-100 text-rose-800"
                }`}>
                  {selectedEventSummary.settlementStatus.replace("_", " ")}
                </span>
              </div>
              <p className="text-xs text-neutral-500 mt-0.5">
                {selectedEventSummary.startDate ? `Event Date: ${new Date(selectedEventSummary.startDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""} · Ticket Base Price: {formatCurrency(selectedEventSummary.price)}
              </p>
            </div>

            {/* Direct Settle Action Button */}
            {selectedEventSummary.remainingBalance > 0 && (
              <button
                onClick={() => {
                  setPayoutModalEventId(selectedEventSummary.id)
                  setPayoutModalAmount((selectedEventSummary.remainingBalance / 100).toFixed(2))
                  setIsPayoutModalOpen(true)
                }}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white shadow-xs hover:bg-emerald-700 active:scale-98 transition-all shrink-0"
              >
                <span>⚡ Settle Event Balance</span>
                <span className="rounded bg-emerald-700 px-1.5 py-0.5 text-xs font-mono">
                  {formatCurrency(selectedEventSummary.remainingBalance)}
                </span>
              </button>
            )}
          </div>

          {/* 6 Event KPI Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-4">
            {/* 1. Gross Ticket Sales */}
            <div className="rounded-xl border border-neutral-200 bg-neutral-50/70 p-3">
              <span className="text-[11px] font-bold text-neutral-500 uppercase tracking-wide">
                Gross Sales
              </span>
              <p className="mt-1 text-lg font-black text-neutral-900">
                {formatCurrency(selectedEventSummary.gross)}
              </p>
              <p className="text-[10px] text-neutral-400 mt-0.5">Money in</p>
            </div>

            {/* 2. Platform Fee Earned */}
            <div className="rounded-xl border border-neutral-200 bg-neutral-50/70 p-3">
              <span className="text-[11px] font-bold text-cluvo-primary uppercase tracking-wide">
                Cluvo Fee
              </span>
              <p className="mt-1 text-lg font-black text-cluvo-primary">
                {formatCurrency(selectedEventSummary.platformFee)}
              </p>
              <p className="text-[10px] text-neutral-400 mt-0.5">Platform cut</p>
            </div>

            {/* 3. Refunds Deducted */}
            <div className="rounded-xl border border-neutral-200 bg-neutral-50/70 p-3">
              <span className="text-[11px] font-bold text-rose-600 uppercase tracking-wide">
                Refunds
              </span>
              <p className="mt-1 text-lg font-black text-rose-600">
                {formatCurrency(selectedEventSummary.refunds)}
              </p>
              <p className="text-[10px] text-neutral-400 mt-0.5">Returned to buyers</p>
            </div>

            {/* 4. Event Net Total */}
            <div className="rounded-xl border border-neutral-300 bg-white p-3 shadow-2xs">
              <span className="text-[11px] font-bold text-neutral-700 uppercase tracking-wide">
                Event Net Total
              </span>
              <p className="mt-1 text-lg font-black text-neutral-900">
                {formatCurrency(selectedEventSummary.netOrganizerTotal)}
              </p>
              <p className="text-[10px] text-neutral-400 mt-0.5">Organizer earned</p>
            </div>

            {/* 5. Payouts Settled */}
            <div className="rounded-xl border border-neutral-200 bg-neutral-50/70 p-3">
              <span className="text-[11px] font-bold text-blue-600 uppercase tracking-wide">
                Paid Out
              </span>
              <p className="mt-1 text-lg font-black text-blue-600">
                {formatCurrency(selectedEventSummary.settled)}
              </p>
              <p className="text-[10px] text-neutral-400 mt-0.5">
                {selectedEventSummary.pending > 0 ? `+${formatCurrency(selectedEventSummary.pending)} pending` : "Settled to bank"}
              </p>
            </div>

            {/* 6. Remaining to Settle */}
            <div className={`rounded-xl border p-3 ${
              selectedEventSummary.remainingBalance > 0 ? "border-emerald-300 bg-emerald-50/60 shadow-2xs" : "border-neutral-200 bg-neutral-50"
            }`}>
              <span className={`text-[11px] font-bold uppercase tracking-wide ${
                selectedEventSummary.remainingBalance > 0 ? "text-emerald-800" : "text-neutral-500"
              }`}>
                Remaining Due
              </span>
              <p className={`mt-1 text-lg font-black ${
                selectedEventSummary.remainingBalance > 0 ? "text-emerald-700" : "text-neutral-700"
              }`}>
                {formatCurrency(selectedEventSummary.remainingBalance)}
              </p>
              <p className="text-[10px] text-neutral-400 mt-0.5">
                {selectedEventSummary.remainingBalance > 0 ? "Payable for this event" : "Fully settled"}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Financial KPI Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
            {/* Gross Sales */}
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-xs">
              <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">
                Gross Ticket Sales
              </span>
              <p className="mt-1.5 text-xl font-black text-neutral-900">
                {formatCurrency(kpis.grossRevenue)}
              </p>
              <p className="mt-1 text-[11px] text-neutral-400">
                From Razorpay customer payments
              </p>
            </div>

            {/* Platform Fees */}
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-xs">
              <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">
                Platform Fees (6%)
              </span>
              <p className="mt-1.5 text-xl font-black text-cluvo-primary">
                {formatCurrency(kpis.platformFees)}
              </p>
              <p className="mt-1 text-[11px] text-neutral-400">
                Cluvo platform revenue
              </p>
            </div>

            {/* Refunds */}
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-xs">
              <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">
                Refunds Deducted
              </span>
              <p className="mt-1.5 text-xl font-black text-rose-600">
                {formatCurrency(kpis.refundsDeducted)}
              </p>
              <p className="mt-1 text-[11px] text-neutral-400">
                Clawed back to customers
              </p>
            </div>

            {/* Payouts Settled */}
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-xs">
              <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">
                Payouts Settled
              </span>
              <p className="mt-1.5 text-xl font-black text-blue-600">
                {formatCurrency(kpis.payoutsSettled)}
              </p>
              <p className="mt-1 text-[11px] text-neutral-400">
                Transferred to organizer
              </p>
            </div>

            {/* Unpaid Balance */}
            <div className="col-span-2 sm:col-span-1 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4 shadow-xs">
              <span className="text-xs font-semibold text-emerald-800 uppercase tracking-wide">
                Current Wallet Balance
              </span>
              <p className="mt-1.5 text-xl font-black text-emerald-700">
                {formatCurrency(kpis.walletBalance)}
              </p>
              <p className="mt-1 text-[11px] text-emerald-600">
                {kpis.payoutsPending > 0 || kpis.payoutsDisputed > 0 ? (
                  <>
                    Available: {formatCurrency(kpis.uncommittedPayable)} (locked: {formatCurrency(kpis.payoutsPending + kpis.payoutsDisputed)})
                  </>
                ) : (
                  "Payable to organizer"
                )}
              </p>
            </div>
          </div>

          {/* Event-Wise Settlement Breakdown Table */}
          {eventBreakdownList.length > 0 && (
            <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-neutral-100 mb-4 gap-1">
                <div>
                  <h4 className="text-base font-bold text-neutral-900">
                    Event Settlement & Earnings Breakdown
                  </h4>
                  <p className="text-xs text-neutral-500">
                    Financial performance and settlement status across all {eventBreakdownList.length} events of {selectedCommunity?.name || "this community"}.
                  </p>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-neutral-200 bg-neutral-50/70 text-neutral-500 font-bold uppercase tracking-wider">
                      <th className="py-2.5 px-3">Event Name</th>
                      <th className="py-2.5 px-3 text-right">Gross Sales</th>
                      <th className="py-2.5 px-3 text-right">Cluvo Fee</th>
                      <th className="py-2.5 px-3 text-right">Refunds</th>
                      <th className="py-2.5 px-3 text-right font-black">Net Total</th>
                      <th className="py-2.5 px-3 text-right">Settled</th>
                      <th className="py-2.5 px-3 text-right text-emerald-700 font-black">Remaining</th>
                      <th className="py-2.5 px-3 text-center">Status</th>
                      <th className="py-2.5 px-3 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {eventBreakdownList.map((ev) => (
                      <tr key={ev.id} className="hover:bg-neutral-50/70 transition-colors">
                        <td className="py-3 px-3 font-semibold text-neutral-900 max-w-[220px]">
                          <button
                            onClick={() => setSelectedEventId(ev.id)}
                            className="text-left font-bold text-neutral-900 hover:text-cluvo-primary hover:underline truncate block"
                          >
                            {ev.title}
                          </button>
                          <span className="text-[10px] text-neutral-400 block mt-0.5">
                            {ev.startDate ? new Date(ev.startDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"} · Base: {formatCurrency(ev.price)}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-right font-medium text-neutral-900">
                          {formatCurrency(ev.gross)}
                        </td>
                        <td className="py-3 px-3 text-right text-cluvo-primary font-medium">
                          {formatCurrency(ev.platformFee)}
                        </td>
                        <td className="py-3 px-3 text-right text-rose-600 font-medium">
                          {formatCurrency(ev.refunds)}
                        </td>
                        <td className="py-3 px-3 text-right font-bold text-neutral-900">
                          {formatCurrency(ev.netOrganizerTotal)}
                        </td>
                        <td className="py-3 px-3 text-right text-blue-600 font-medium">
                          {formatCurrency(ev.settled)}
                          {ev.pending > 0 && (
                            <span className="block text-[9px] text-amber-600">
                              +{formatCurrency(ev.pending)} pend.
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-black text-emerald-700">
                          {formatCurrency(ev.remainingBalance)}
                        </td>
                        <td className="py-3 px-3 text-center">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                            ev.settlementStatus === "fully_settled" ? "bg-emerald-100 text-emerald-800" :
                            ev.settlementStatus === "pending_confirmation" ? "bg-amber-100 text-amber-800" :
                            ev.settlementStatus === "partially_settled" ? "bg-blue-100 text-blue-800" :
                            ev.settlementStatus === "no_sales" ? "bg-neutral-100 text-neutral-600" :
                            "bg-rose-100 text-rose-800"
                          }`}>
                            {ev.settlementStatus.replace("_", " ")}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => setSelectedEventId(ev.id)}
                              className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-[11px] font-semibold text-neutral-700 hover:bg-neutral-50 shadow-2xs"
                              title="Filter Passbook to this event"
                            >
                              Ledger
                            </button>
                            {ev.remainingBalance > 0 && (
                              <button
                                onClick={() => {
                                  setPayoutModalEventId(ev.id)
                                  setPayoutModalAmount((ev.remainingBalance / 100).toFixed(2))
                                  setIsPayoutModalOpen(true)
                                }}
                                className="rounded-lg bg-emerald-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-emerald-700 shadow-2xs"
                                title="Settle remaining balance for this event"
                              >
                                Pay
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Error Banner */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{error}</span>
          </div>
          <button
            onClick={loadStatement}
            className="font-bold underline hover:text-red-950"
          >
            Retry
          </button>
        </div>
      )}

      {/* Passbook Ledger Container */}
      <div className="rounded-2xl border border-neutral-200 bg-white shadow-xs overflow-hidden">
        {/* Passbook Section Header */}
        <div className="border-b border-neutral-200 px-4 py-3 bg-neutral-50/60 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <div>
            <h4 className="text-sm font-bold text-neutral-900 flex items-center gap-2">
              <span>{selectedEventId === "all" ? "Consolidated Passbook Ledger" : `Event Passbook: ${selectedEventSummary?.title || "Selected Event"}`}</span>
              <span className="text-xs font-normal text-neutral-500">({filteredStatement.length} entries)</span>
            </h4>
            <p className="text-[11px] text-neutral-500">
              {selectedEventId === "all"
                ? "Full transaction history across all events, customer refunds, and platform transfers."
                : `Audited ticket sales, refunds, and bank settlements strictly for ${selectedEventSummary?.title || "this event"}.`}
            </p>
          </div>
        </div>

        {/* Table Toolbar & Search */}
        <div className="border-b border-neutral-200 p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-neutral-50/50">
          {/* Filter Tabs */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setFilterType("all")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                filterType === "all"
                  ? "bg-neutral-900 text-white"
                  : "bg-white border border-neutral-200 text-neutral-600 hover:bg-neutral-100"
              }`}
            >
              All Transactions ({statement.length})
            </button>
            <button
              onClick={() => setFilterType("ticket_sale")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                filterType === "ticket_sale"
                  ? "bg-emerald-700 text-white"
                  : "bg-white border border-neutral-200 text-neutral-600 hover:bg-neutral-100"
              }`}
            >
              Ticket Sales (Credits)
            </button>
            <button
              onClick={() => setFilterType("refund")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                filterType === "refund"
                  ? "bg-rose-700 text-white"
                  : "bg-white border border-neutral-200 text-neutral-600 hover:bg-neutral-100"
              }`}
            >
              Refunds (Debits)
            </button>
            <button
              onClick={() => setFilterType("payout")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                filterType === "payout"
                  ? "bg-blue-700 text-white"
                  : "bg-white border border-neutral-200 text-neutral-600 hover:bg-neutral-100"
              }`}
            >
              Payout Settlements
            </button>
          </div>

          {/* Search Box */}
          <div className="relative min-w-[260px]">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by ID, name, email, UTR..."
              className="w-full rounded-lg border border-neutral-300 pl-8 pr-3 py-1.5 text-xs text-neutral-900 focus:border-cluvo-primary focus:outline-none bg-white"
            />
            <svg
              className="absolute left-2.5 top-2 h-3.5 w-3.5 text-neutral-400 pointer-events-none"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-2 text-neutral-400 hover:text-neutral-700 text-xs"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Ledger Table */}
        {loadingStatement ? (
          <div className="py-20 text-center">
            <svg className="mx-auto h-8 w-8 animate-spin text-cluvo-primary" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="mt-2 text-xs text-neutral-500">Retrieving passbook from ledger...</p>
          </div>
        ) : filteredStatement.length === 0 ? (
          <div className="py-16 text-center">
            <svg className="mx-auto h-12 w-12 text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="mt-2 text-sm font-semibold text-neutral-700">No transactions recorded</p>
            <p className="text-xs text-neutral-400 mt-0.5">
              {searchQuery
                ? "No transactions match your search filter."
                : selectedEventId !== "all"
                ? "This event has no ticket sales, refunds, or payouts yet."
                : "This community has no financial transactions yet."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-neutral-200 text-left text-xs">
              <thead className="bg-neutral-50 font-bold uppercase tracking-wider text-neutral-500">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Date & Time (Latest Top)
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Description & Party
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Reference IDs
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Money In (+)
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Money Out (−)
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Running Balance
                  </th>
                  <th scope="col" className="px-4 py-3 text-center">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Inspection
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 bg-white">
                {filteredStatement.map((tx) => {
                  const isCredit = tx.money_in > 0
                  const isRefund = tx.transaction_type === "refund"
                  const isPayout = tx.transaction_type.startsWith("payout")

                  return (
                    <tr
                      key={tx.transaction_id}
                      className="hover:bg-neutral-50/80 transition-colors group"
                    >
                      {/* Date & Time */}
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <span className="font-semibold text-neutral-900 block">
                          {formatDateTime(tx.created_at)}
                        </span>
                        <span className="text-[10px] text-neutral-400 font-mono">
                          {new Date(tx.created_at).toLocaleTimeString("en-IN", {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                      </td>

                      {/* Description & Party */}
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                              isCredit
                                ? "bg-emerald-100 text-emerald-700"
                                : isRefund
                                ? "bg-rose-100 text-rose-700"
                                : "bg-blue-100 text-blue-700"
                            }`}
                          >
                            {isCredit ? "↓" : "↑"}
                          </span>
                          <div className="min-w-0">
                            <p className="font-semibold text-neutral-900 truncate max-w-[200px]">
                              {tx.description}
                            </p>
                            <p className="text-[11px] text-neutral-500 truncate max-w-[200px]">
                              {tx.attendee_name || tx.event_title || "General Ledger"}
                            </p>
                          </div>
                        </div>
                      </td>

                      {/* Reference IDs with Copy */}
                      <td className="px-4 py-3.5 whitespace-nowrap font-mono text-[11px]">
                        {tx.reference_id ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-neutral-800 font-semibold truncate max-w-[150px]">
                              {tx.reference_id}
                            </span>
                            <button
                              onClick={() => copyText(tx.reference_id!, `ref_${tx.transaction_id}`)}
                              className="rounded p-1 text-neutral-400 hover:text-cluvo-primary hover:bg-neutral-200 transition-colors"
                              title="Copy Reference ID"
                            >
                              {copiedKey === `ref_${tx.transaction_id}` ? (
                                <span className="text-[10px] text-emerald-600 font-bold">✓</span>
                              ) : (
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                              )}
                            </button>
                          </div>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                        {tx.secondary_ref && (
                          <span className="text-[10px] text-neutral-400 block truncate max-w-[150px]">
                            {tx.secondary_ref}
                          </span>
                        )}
                      </td>

                      {/* Money In */}
                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        {isCredit ? (
                          <span className="font-bold text-emerald-700">
                            +{formatCurrency(tx.money_in)}
                          </span>
                        ) : (
                          <span className="text-neutral-300">—</span>
                        )}
                      </td>

                      {/* Money Out */}
                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        {tx.money_out > 0 ? (
                          <span
                            className={`font-bold ${
                              isRefund ? "text-rose-600" : "text-blue-600"
                            }`}
                          >
                            −{formatCurrency(tx.money_out)}
                          </span>
                        ) : (
                          <span className="text-neutral-300">—</span>
                        )}
                      </td>

                      {/* Running Balance */}
                      <td className="px-4 py-3.5 text-right whitespace-nowrap font-semibold text-neutral-900">
                        {formatCurrency(tx.running_balance)}
                      </td>

                      {/* Status Badge */}
                      <td className="px-4 py-3.5 text-center whitespace-nowrap">
                        {tx.status === "success" || tx.status === "processed" ? (
                          <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                            Success
                          </span>
                        ) : tx.status === "refunded" ? (
                          <span className="inline-flex rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-700 ring-1 ring-inset ring-rose-600/20">
                            Refunded
                          </span>
                        ) : tx.status === "pending_confirmation" ? (
                          <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700 ring-1 ring-inset ring-amber-600/20">
                            Pending Conf.
                          </span>
                        ) : tx.status === "disputed" ? (
                          <span className="inline-flex rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-700 ring-1 ring-inset ring-red-600/20">
                            Disputed
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-bold text-neutral-600 ring-1 ring-inset ring-neutral-500/20">
                            {tx.status}
                          </span>
                        )}
                      </td>

                      {/* Action: Open Inspector Drawer */}
                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        <button
                          onClick={() => setInspectedTx(tx)}
                          className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-semibold text-neutral-700 shadow-2xs hover:border-cluvo-primary hover:text-cluvo-primary transition-colors"
                        >
                          <span>View</span>
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Slide-over Inspection Drawer */}
      <TransactionDetailDrawer
        transaction={inspectedTx}
        onClose={() => setInspectedTx(null)}
      />

      {/* Manual Payout Modal */}
      <ManualPayoutModal
        isOpen={isPayoutModalOpen}
        onClose={() => {
          setIsPayoutModalOpen(false)
          setPayoutModalEventId(null)
          setPayoutModalAmount(null)
        }}
        onSuccess={() => {
          loadStatement()
          if (selectedCommunityId) {
            supabase
              .rpc("get_community_financials", { p_community_id: selectedCommunityId })
              .then((res) => {
                if (res.data?.[0]) {
                  const bal = res.data[0].wallet_balance ?? 0
                  setSelectedCommunityBalance(bal)
                  setCommunities((prev) =>
                    prev.map((c) => (c.id === selectedCommunityId ? { ...c, wallet_balance: bal } : c))
                  )
                }
              })
          }
        }}
        community={selectedCommunity}
        events={events}
        eventSummaries={eventBreakdownList}
        beneficiary={beneficiary}
        defaultEventId={payoutModalEventId}
        defaultAmountRupees={payoutModalAmount}
      />

      {/* Manual Refund Review Modal (Milestone B) */}
      <RefundManualReviewModal
        isOpen={selectedTaskForReview !== null}
        task={selectedTaskForReview}
        onClose={() => setSelectedTaskForReview(null)}
        onResolved={() => {
          loadStatement()
          loadUnresolvedTasks()
        }}
      />
    </div>
  )
}
