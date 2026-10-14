import { useEffect, useState } from "react"
import { supabase } from "../supabase"

interface ContentReport {
  id: string
  reporter_id: string
  target_type: "event_message" | "community" | "event" | "user"
  target_id: string
  target_user_id: string | null
  reason: string
  details: string | null
  status: "open" | "reviewed" | "dismissed" | "actioned"
  created_at: string
  reviewed_at: string | null
}

type StatusFilter = "all" | ContentReport["status"]

const STATUS_PILLS: Record<ContentReport["status"], string> = {
  open: "bg-orange-50 text-orange-600",
  reviewed: "bg-sky-50 text-sky-600",
  dismissed: "bg-neutral-100 text-neutral-500",
  actioned: "bg-emerald-50 text-emerald-600",
}

const TYPE_LABELS: Record<ContentReport["target_type"], string> = {
  event_message: "Message",
  community: "Community",
  event: "Event",
  user: "User",
}

export default function ReportsPage() {
  const [reports, setReports] = useState<ContentReport[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [pendingId, setPendingId] = useState<string | null>(null)

  const load = async () => {
    const { data, error: err } = await supabase
      .from("content_reports")
      .select("*")
      .order("created_at", { ascending: false })
    if (err) {
      setError(err.message)
      setLoading(false)
      return
    }
    const rows = (data ?? []) as ContentReport[]
    setReports(rows)
    setError(null)

    const ids = Array.from(
      new Set(
        rows
          .flatMap((r) => [r.reporter_id, r.target_user_id])
          .filter((id): id is string => Boolean(id)),
      ),
    )
    if (ids.length > 0) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, first_name, last_name")
        .in("id", ids)
      const map: Record<string, string> = {}
      for (const p of (profs ?? []) as {
        id: string
        first_name: string | null
        last_name: string | null
      }[]) {
        const name = [p.first_name, p.last_name].filter(Boolean).join(" ").trim()
        map[p.id] = name || "Unnamed user"
      }
      setNames(map)
    } else {
      setNames({})
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])

  const updateStatus = async (r: ContentReport, status: ContentReport["status"]) => {
    setPendingId(r.id)
    const { error: err } = await supabase
      .from("content_reports")
      .update({ status })
      .eq("id", r.id)
    setPendingId(null)
    if (err) setError(err.message)
    else await load()
  }

  const label = (id: string | null) =>
    id ? names[id] || id.slice(0, 8) + "…" : "—"

  const filtered = reports.filter(
    (r) => statusFilter === "all" || r.status === statusFilter,
  )

  const openCount = reports.filter((r) => r.status === "open").length

  return (
    <div>
      <h3 className="text-xl font-semibold text-neutral-900">Reports</h3>
      <p className="mt-2 text-sm text-neutral-500">
        User-submitted reports of objectionable content or abuse. Review each and act.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="mr-2 text-xs font-medium text-neutral-500">
          {openCount} open
        </span>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="rounded-lg border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 focus:border-cluvo-primary focus:outline-none"
        >
          <option value="all">All statuses</option>
          <option value="open">Open</option>
          <option value="reviewed">Reviewed</option>
          <option value="dismissed">Dismissed</option>
          <option value="actioned">Actioned</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <svg className="h-8 w-8 animate-spin text-cluvo-primary" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      ) : error ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">
          Failed to load reports: {error}
        </div>
      ) : filtered.length === 0 ? (
        <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-8 text-center">
          <p className="text-sm text-neutral-500">
            {reports.length === 0 ? "No reports yet." : "No reports match this filter."}
          </p>
        </div>
      ) : (
        <>
          <div className="mt-6 space-y-3 md:hidden">
            {filtered.map((r) => (
              <div key={r.id} className="rounded-xl border border-neutral-200 bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                    {TYPE_LABELS[r.target_type] ?? r.target_type}
                  </span>
                  <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_PILLS[r.status]}`}>
                    {r.status}
                  </span>
                </div>
                <p className="mt-2 font-medium text-neutral-900">{r.reason}</p>
                {r.details && <p className="mt-0.5 text-xs text-neutral-500">{r.details}</p>}
                <dl className="mt-3 space-y-1 text-xs text-neutral-500">
                  <div className="flex justify-between gap-3">
                    <dt>Reported user</dt>
                    <dd className="text-neutral-700">{label(r.target_user_id)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Reporter</dt>
                    <dd className="text-neutral-700">{label(r.reporter_id)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Created</dt>
                    <dd className="text-neutral-700">{new Date(r.created_at).toLocaleString()}</dd>
                  </div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  {r.status === "open" ? (
                    <>
                      <button
                        onClick={() => updateStatus(r, "dismissed")}
                        disabled={pendingId === r.id}
                        className="flex-1 rounded-lg border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
                      >
                        {pendingId === r.id ? "..." : "Dismiss"}
                      </button>
                      <button
                        onClick={() => updateStatus(r, "actioned")}
                        disabled={pendingId === r.id}
                        className="flex-1 rounded-lg bg-cluvo-primary px-2.5 py-1.5 text-xs font-medium text-white hover:bg-cluvo-primary-dark disabled:opacity-50"
                      >
                        {pendingId === r.id ? "..." : "Actioned"}
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-neutral-400">
                      {r.reviewed_at ? new Date(r.reviewed_at).toLocaleString() : "Handled"}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 hidden overflow-x-auto rounded-xl border border-neutral-200 bg-white md:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50">
                  <th className="px-4 py-3 font-medium text-neutral-600">Type</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Reason</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Reported user</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Reporter</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Status</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Created</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100 transition-colors hover:bg-neutral-50">
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                        {TYPE_LABELS[r.target_type] ?? r.target_type}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-neutral-900">{r.reason}</p>
                      {r.details && (
                        <p className="mt-0.5 text-xs text-neutral-500">{r.details}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-neutral-600">{label(r.target_user_id)}</td>
                    <td className="px-4 py-3 text-neutral-600">{label(r.reporter_id)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_PILLS[r.status]}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-neutral-600">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      {r.status === "open" ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => updateStatus(r, "dismissed")}
                            disabled={pendingId === r.id}
                            className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
                          >
                            {pendingId === r.id ? "..." : "Dismiss"}
                          </button>
                          <button
                            onClick={() => updateStatus(r, "actioned")}
                            disabled={pendingId === r.id}
                            className="rounded-lg bg-cluvo-primary px-2.5 py-1 text-xs font-medium text-white hover:bg-cluvo-primary-dark disabled:opacity-50"
                          >
                            {pendingId === r.id ? "..." : "Actioned"}
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-neutral-400">
                          {r.reviewed_at ? new Date(r.reviewed_at).toLocaleString() : "Handled"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
