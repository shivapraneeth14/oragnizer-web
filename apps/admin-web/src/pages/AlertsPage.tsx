import { useEffect, useState } from "react"
import { supabase } from "../supabase"

interface AdminAlert {
  id: string
  severity: "info" | "warning" | "critical"
  category: string
  title: string
  details: Record<string, unknown> | null
  status: "open" | "acknowledged" | "resolved"
  created_at: string
  resolved_at: string | null
}

type SeverityFilter = "all" | "critical" | "warning" | "info"
type StatusFilter = "all" | "open" | "acknowledged" | "resolved"

const SEVERITY_PILLS: Record<AdminAlert["severity"], { pill: string; dot: string; label: string }> = {
  critical: { pill: "bg-red-50 text-red-600", dot: "bg-red-500", label: "Critical" },
  warning: { pill: "bg-amber-50 text-amber-600", dot: "bg-amber-500", label: "Warning" },
  info: { pill: "bg-blue-50 text-blue-600", dot: "bg-blue-500", label: "Info" },
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AdminAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [pendingId, setPendingId] = useState<string | null>(null)

  const load = async () => {
    const { data, error: err } = await supabase
      .from("admin_alerts")
      .select("*")
      .order("created_at", { ascending: false })
    if (err) {
      setError(err.message)
    } else if (data) {
      setAlerts(data as AdminAlert[])
      setError(null)
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])

  const updateStatus = async (a: AdminAlert, status: AdminAlert["status"]) => {
    setPendingId(a.id)
    const { error: err } = await supabase
      .from("admin_alerts")
      .update({ status })
      .eq("id", a.id)
    setPendingId(null)
    if (err) setError(err.message)
    else await load()
  }

  const filtered = alerts.filter(
    (a) =>
      (severityFilter === "all" || a.severity === severityFilter) &&
      (statusFilter === "all" || a.status === statusFilter),
  )

  return (
    <div>
      <h3 className="text-xl font-semibold text-neutral-900">Alerts</h3>
      <p className="mt-2 text-sm text-neutral-500">
        Failures reported by background jobs — acknowledge while handling, resolve when fixed.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {(["all", "critical", "warning", "info"] as SeverityFilter[]).map((s) => (
          <button
            key={s}
            onClick={() => setSeverityFilter(s)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              severityFilter === s
                ? "bg-[#C2185B] text-white"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
            }`}
          >
            {s === "all" ? "All" : SEVERITY_PILLS[s as AdminAlert["severity"]].label}
          </button>
        ))}
        <span className="mx-2 hidden h-4 w-px bg-neutral-200 sm:block" />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="rounded-lg border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 focus:border-[#C2185B] focus:outline-none"
        >
          <option value="all">All statuses</option>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <svg className="h-8 w-8 animate-spin text-[#C2185B]" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      ) : error ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">
          Failed to load alerts: {error}
        </div>
      ) : filtered.length === 0 ? (
        <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-8 text-center">
          <p className="text-sm text-neutral-500">
            {alerts.length === 0 ? "No alerts yet — all quiet." : "No alerts match this filter."}
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-neutral-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50">
                <th className="px-4 py-3 font-medium text-neutral-600">Severity</th>
                <th className="px-4 py-3 font-medium text-neutral-600">Alert</th>
                <th className="px-4 py-3 font-medium text-neutral-600">Status</th>
                <th className="px-4 py-3 font-medium text-neutral-600">Created</th>
                <th className="px-4 py-3 font-medium text-neutral-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => {
                const sev = SEVERITY_PILLS[a.severity]
                return (
                  <tr key={a.id} className="border-b border-neutral-100 transition-colors hover:bg-neutral-50">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${sev.pill}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${sev.dot}`} />
                        {sev.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-neutral-900">{a.title}</p>
                      <span className="mt-0.5 inline-block rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                        {a.category}
                      </span>
                      {a.details && Object.keys(a.details).length > 0 && (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-xs text-[#C2185B] hover:text-[#A0174A]">
                            Details
                          </summary>
                          <pre className="mt-1.5 overflow-x-auto rounded-lg bg-neutral-50 p-2 text-xs text-neutral-600">
                            {JSON.stringify(a.details, null, 2)}
                          </pre>
                        </details>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          a.status === "resolved"
                            ? "bg-emerald-50 text-emerald-600"
                            : a.status === "acknowledged"
                              ? "bg-sky-50 text-sky-600"
                              : "bg-orange-50 text-orange-600"
                        }`}
                      >
                        {a.status}
                      </span>
                      {a.resolved_at && (
                        <p className="mt-1 text-xs text-neutral-400">
                          {new Date(a.resolved_at).toLocaleString()}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-neutral-600">{new Date(a.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {a.status === "open" && (
                          <button
                            onClick={() => updateStatus(a, "acknowledged")}
                            disabled={pendingId === a.id}
                            className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
                          >
                            {pendingId === a.id ? "..." : "Acknowledge"}
                          </button>
                        )}
                        {a.status !== "resolved" && (
                          <button
                            onClick={() => updateStatus(a, "resolved")}
                            disabled={pendingId === a.id}
                            className="rounded-lg bg-[#C2185B] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#A0174A] disabled:opacity-50"
                          >
                            {pendingId === a.id ? "..." : "Resolve"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}