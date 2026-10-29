import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { supabase } from "../supabase"
import { fetchAdminProfiles } from "../lib/admin-profiles"
import { COMMUNITY_CLIENT_COLUMNS_SELECT, type Community } from "shared"

const GRACE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

function daysRemaining(startedAt: string) {
  const due = new Date(new Date(startedAt).getTime() + GRACE_DAYS * DAY_MS).getTime()
  return Math.max(0, Math.ceil((due - Date.now()) / DAY_MS))
}

const FILTERS = [
  { key: "active", label: "Active" },
  { key: "scheduled", label: "Scheduled for closure" },
  { key: "all", label: "All" },
] as const

export default function CommunitiesPage() {
  const [communities, setCommunities] = useState<(Community & { owner_email?: string; deletion_grace_started_at?: string | null })[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<"active" | "scheduled" | "all">("all")

  useEffect(() => {
    setLoading(true)
    Promise.all([
      supabase.from("communities").select(COMMUNITY_CLIENT_COLUMNS_SELECT).order("created_at", { ascending: false }),
      fetchAdminProfiles(),
    ]).then(([cRes, profiles]) => {
      const emailById = new Map(profiles.map((p) => [p.id, p.email]))
      if (cRes.data) {
        setCommunities(
          (cRes.data as unknown as any[]).map((c) => ({
            ...c,
            owner_email: emailById.get(c.owner_id),
          }))
        )
      }
      setLoading(false)
    }, () => setLoading(false))
  }, [])

  const filtered = communities.filter((c: any) => {
    const scheduled = c.deletion_grace_started_at && !c.deleted_at
    if (filter === "scheduled") return scheduled
    if (filter === "active") return !scheduled && !c.deleted_at
    return true
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <svg className="h-8 w-8 animate-spin text-cluvo-primary" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div>
      <h3 className="text-xl font-semibold text-neutral-900">All Communities</h3>
      <p className="mt-2 text-sm text-neutral-500">Manage and review all communities on the platform.</p>

      <div className="mt-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              filter === f.key
                ? "bg-cluvo-primary text-white"
                : "border border-neutral-200 text-neutral-700 hover:bg-neutral-50"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="mt-8 rounded-xl border border-neutral-200 bg-white p-8 text-center">
          <p className="text-sm text-neutral-500">{filter === "scheduled" ? "No communities scheduled for closure." : filter === "active" ? "No active communities." : "No communities yet."}</p>
        </div>
      ) : (
        <>
          <div className="mt-6 space-y-3 md:hidden">
            {filtered.map((c: any) => (
              <Link key={c.id} to={`/communities/${c.id}`} className="block rounded-xl border border-neutral-200 bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-cluvo-primary">{c.name}</span>
                  {c.is_hidden && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Hidden</span>
                  )}
                </div>
                <dl className="mt-3 space-y-1 text-xs text-neutral-500">
                  <div className="flex justify-between gap-3">
                    <dt>Owner</dt>
                    <dd className="truncate text-neutral-700">{c.owner_email || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Members</dt>
                    <dd className="text-neutral-700">{c.member_count}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Events</dt>
                    <dd className="text-neutral-700">{c.event_count}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Created</dt>
                    <dd className="text-neutral-700">{new Date(c.created_at).toLocaleDateString()}</dd>
                  </div>
                </dl>
              </Link>
            ))}
          </div>

          <div className="mt-6 hidden overflow-x-auto rounded-xl border border-neutral-200 bg-white md:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50">
                  <th className="px-4 py-3 font-medium text-neutral-600">Name</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Owner</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Members</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Events</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Created</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c: any) => {
                  const scheduled = c.deletion_grace_started_at && !c.deleted_at
                  return (
                  <tr key={c.id} className="border-b border-neutral-100 transition-colors hover:bg-neutral-50">
                    <td className="px-4 py-3">
                      <Link to={`/communities/${c.id}`} className="font-medium text-cluvo-primary hover:text-cluvo-primary-dark">
                        {c.name}
                      </Link>
                      {c.is_hidden && !scheduled && <span className="ml-2 text-xs text-amber-600">(Hidden)</span>}
                    </td>
                    <td className="px-4 py-3 text-neutral-600">{c.owner_email || "—"}</td>
                    <td className="px-4 py-3 text-neutral-600">{c.member_count}</td>
                    <td className="px-4 py-3 text-neutral-600">{c.event_count}</td>
                    <td className="px-4 py-3 text-neutral-600">{new Date(c.created_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      {scheduled ? (
                        <span className="rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-600">Closure scheduled · {daysRemaining(c.deletion_grace_started_at)}d left</span>
                      ) : c.is_hidden ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Hidden</span>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
