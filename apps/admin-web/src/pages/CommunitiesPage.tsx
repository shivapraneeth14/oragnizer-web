import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { supabase } from "../supabase"
import type { Community } from "shared"

export default function CommunitiesPage() {
  const [communities, setCommunities] = useState<(Community & { owner_email?: string })[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from("communities")
      .select("*, profiles!owner_id(email)")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (data) {
          setCommunities(
            data.map((c) => ({
              ...c,
              owner_email: (c as any).profiles?.email,
            }))
          )
        }
        setLoading(false)
      })
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <svg className="h-8 w-8 animate-spin text-[#C2185B]" viewBox="0 0 24 24" fill="none">
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

      {communities.length === 0 ? (
        <div className="mt-8 rounded-xl border border-neutral-200 bg-white p-8 text-center">
          <p className="text-sm text-neutral-500">No communities yet.</p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-neutral-200 bg-white">
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
              {communities.map((c) => (
                <tr key={c.id} className="border-b border-neutral-100 transition-colors hover:bg-neutral-50">
                  <td className="px-4 py-3">
                    <Link to={`/communities/${c.id}`} className="font-medium text-[#C2185B] hover:text-[#A0174A]">
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-neutral-600">{c.owner_email || "—"}</td>
                  <td className="px-4 py-3 text-neutral-600">{c.member_count}</td>
                  <td className="px-4 py-3 text-neutral-600">{c.event_count}</td>
                  <td className="px-4 py-3 text-neutral-600">{new Date(c.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    {c.is_hidden ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Hidden</span>
                    ) : (
                      <span className="text-neutral-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
