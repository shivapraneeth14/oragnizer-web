import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { supabase } from "../supabase"
import StatCard from "../components/StatCard"
import { formatCurrency } from "../components/TransactionDetailDrawer"

interface FinancialKpis {
  system_health: "HEALTHY" | "WARNING" | "CRITICAL"
  total_stored_wallet_paise: number
  total_pending_payouts_paise: number
  total_disputed_payouts_paise: number
  total_uncommitted_payable_paise: number
  disputed_payouts_count: number
  alert_queue_tasks_count: number
  total_communities_count: number
  timestamp: string
}

export default function DashboardPage() {
  const [counts, setCounts] = useState({ communities: 0, users: 0, events: 0, members: 0 })
  const [loading, setLoading] = useState(true)
  const [financialKpis, setFinancialKpis] = useState<FinancialKpis | null>(null)
  const [loadingKpis, setLoadingKpis] = useState(true)

  useEffect(() => {
    Promise.all([
      supabase.from("communities").select("id", { count: "exact", head: true }),
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("events").select("id", { count: "exact", head: true }),
      supabase.from("community_members").select("id", { count: "exact", head: true }),
    ]).then(([c, p, e, m]) => {
      setCounts({
        communities: c.count ?? 0,
        users: p.count ?? 0,
        events: e.count ?? 0,
        members: m.count ?? 0,
      })
      setLoading(false)
    }, () => setLoading(false))

    // Load Financial Observability KPIs (Milestone D)
    supabase
      .rpc("get_financial_observability_kpis")
      .then(({ data, error }) => {
        if (!error && data) {
          setFinancialKpis(data as FinancialKpis)
        }
        setLoadingKpis(false)
      }, () => setLoadingKpis(false))
  }, [])

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-xl font-semibold text-neutral-900">Platform Overview</h3>
        <p className="mt-2 text-sm text-neutral-500">Summary of all activity across Cluvo.</p>
        <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard title="Total Communities" value={loading ? "..." : counts.communities} label="All communities on the platform" />
          <StatCard title="Total Users" value={loading ? "..." : counts.users} label="All registered users" />
          <StatCard title="Total Events" value={loading ? "..." : counts.events} label="All events across communities" />
          <StatCard title="Total Memberships" value={loading ? "..." : counts.members} label="Total community memberships" />
        </div>
      </div>

      {/* Financial Health & Observability Card (Stage 5 Milestone D) */}
      <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-100 pb-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-pink-50 text-cluvo-primary text-xl font-bold">
              ⚖️
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-base font-bold text-neutral-900">
                  Financial Reconciliation & Health
                </h4>
                {financialKpis && (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      financialKpis.system_health === "HEALTHY"
                        ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20"
                        : financialKpis.system_health === "WARNING"
                        ? "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20"
                        : "bg-rose-50 text-rose-700 ring-1 ring-rose-600/20"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        financialKpis.system_health === "HEALTHY"
                          ? "bg-emerald-600 animate-pulse"
                          : financialKpis.system_health === "WARNING"
                          ? "bg-amber-600"
                          : "bg-rose-600 animate-bounce"
                      }`}
                    />
                    {financialKpis.system_health}
                  </span>
                )}
              </div>
              <p className="text-xs text-neutral-500 mt-0.5">
                Real-time 3-way balance integrity, refund queue health, and settlement liability tracking.
              </p>
            </div>
          </div>

          <Link
            to="/financials"
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-700 shadow-xs hover:bg-neutral-50 transition-colors self-start sm:self-auto"
          >
            <span>Open Financial Ledger & Audit</span>
            <svg className="h-4 w-4 text-neutral-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
            </svg>
          </Link>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5">
          <div className="rounded-xl border border-neutral-100 bg-neutral-50/50 p-4">
            <span className="block text-xs font-bold uppercase tracking-wider text-neutral-400">
              Total Stored Wallet
            </span>
            <div className="mt-1 text-lg font-extrabold text-neutral-900">
              {loadingKpis ? "..." : formatCurrency(financialKpis?.total_stored_wallet_paise ?? 0)}
            </div>
            <span className="text-[11px] text-neutral-500">Platform wallet liability</span>
          </div>

          <div className="rounded-xl border border-amber-100 bg-amber-50/30 p-4">
            <span className="block text-xs font-bold uppercase tracking-wider text-amber-800">
              Pending Payouts
            </span>
            <div className="mt-1 text-lg font-extrabold text-amber-700">
              {loadingKpis ? "..." : formatCurrency(financialKpis?.total_pending_payouts_paise ?? 0)}
            </div>
            <span className="text-[11px] text-amber-600">Awaiting organizer confirm</span>
          </div>

          <div className="rounded-xl border border-rose-100 bg-rose-50/30 p-4">
            <span className="block text-xs font-bold uppercase tracking-wider text-rose-800">
              Disputed Payouts
            </span>
            <div className="mt-1 text-lg font-extrabold text-rose-700">
              {loadingKpis ? "..." : `${financialKpis?.disputed_payouts_count ?? 0} (${formatCurrency(financialKpis?.total_disputed_payouts_paise ?? 0)})`}
            </div>
            <span className="text-[11px] text-rose-600">Requires investigation</span>
          </div>

          <div className="rounded-xl border border-emerald-100 bg-emerald-50/30 p-4">
            <span className="block text-xs font-bold uppercase tracking-wider text-emerald-800">
              Uncommitted Payable
            </span>
            <div className="mt-1 text-lg font-extrabold text-emerald-700">
              {loadingKpis ? "..." : formatCurrency(financialKpis?.total_uncommitted_payable_paise ?? 0)}
            </div>
            <span className="text-[11px] text-emerald-600">Available uncommitted</span>
          </div>
        </div>
      </div>
    </div>
  )
}
