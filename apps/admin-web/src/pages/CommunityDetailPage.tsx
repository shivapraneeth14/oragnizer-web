import { useEffect, useState } from "react"
import { useParams, Link, useNavigate } from "react-router-dom"
import { supabase } from "../supabase"
import type { Community, Profile, CommunityMember, Event } from "shared"

export default function CommunityDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [community, setCommunity] = useState<Community | null>(null)
  const [owner, setOwner] = useState<Profile | null>(null)
  const [members, setMembers] = useState<(CommunityMember & { email?: string })[]>([])
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [togglingHidden, setTogglingHidden] = useState(false)

  useEffect(() => {
    if (!id) return
    Promise.all([
      supabase.from("communities").select("*").eq("id", id).single(),
      supabase.from("community_members").select("*, profiles!inner(email)").eq("community_id", id).order("joined_at"),
    ]).then(([cRes, mRes]) => {
      const comm = cRes.data as Community | null
      setCommunity(comm)
      if (comm) {
        supabase.from("profiles").select("*").eq("id", comm.owner_id).single().then(({ data: o }) => setOwner(o as Profile))
        supabase.from("events").select("*").eq("community_id", id).order("start_date", { ascending: false }).then(({ data: e }) => setEvents((e as Event[]) || []))
      }
      setMembers((mRes.data as any[] || []).map((m) => ({ ...m, email: m.profiles?.email })))
      setLoading(false)
    })
  }, [id])

  const handleToggleHidden = async () => {
    if (!id) return
    setTogglingHidden(true)
    const { error } = await supabase
      .from("communities")
      .update({ is_hidden: !community?.is_hidden })
      .eq("id", id)
    setTogglingHidden(false)
    if (!error && community) {
      setCommunity({ ...community, is_hidden: !community.is_hidden })
    }
  }

  const handleDelete = async () => {
    if (!id) return
    setDeleting(true)
    const { data: { session } } = await supabase.auth.getSession()
    const { supabaseFetch } = await import("../supabase-fetch")
    const res = await supabaseFetch("/functions/v1/admin-delete-community", session?.access_token, { community_id: id })
    const result = await res.json()
    setDeleting(false)
    setConfirmDelete(false)
    if (result.success) navigate("/communities", { replace: true })
  }

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

  if (!community) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center">
        <p className="text-sm text-neutral-500">Community not found.</p>
        <Link to="/communities" className="mt-2 inline-block text-sm font-medium text-[#C2185B]">Back to Communities</Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Link to="/communities" className="text-sm text-neutral-500 hover:text-[#C2185B]">&larr; Back to Communities</Link>

      <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-xl font-semibold text-neutral-900">{community.name}</h3>
            <p className="mt-1 text-sm text-neutral-500">{community.description || "No description"}</p>
          </div>
          <div className="flex items-center gap-3">
            {community.is_hidden && (
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">
                Hidden from app
              </span>
            )}
            <button
              onClick={handleToggleHidden}
              disabled={togglingHidden}
              className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              {togglingHidden ? "Saving..." : community.is_hidden ? "Make visible" : "Hide from app"}
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              className="rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100"
            >
              Delete
            </button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm lg:grid-cols-3">
          <div><span className="text-neutral-400">Category:</span> <span className="text-neutral-700">{community.category || "—"}</span></div>
          <div><span className="text-neutral-400">Visibility:</span> <span className="text-neutral-700">{community.visibility}</span></div>
          <div><span className="text-neutral-400">Verification:</span> <span className="text-neutral-700">{community.verification_status}</span></div>
          <div><span className="text-neutral-400">Country:</span> <span className="text-neutral-700">{community.country || "—"}</span></div>
          <div><span className="text-neutral-400">State:</span> <span className="text-neutral-700">{community.state || "—"}</span></div>
          <div><span className="text-neutral-400">City:</span> <span className="text-neutral-700">{community.city || "—"}</span></div>
          <div><span className="text-neutral-400">Contact Email:</span> <span className="text-neutral-700">{community.contact_email || "—"}</span></div>
          <div><span className="text-neutral-400">Contact Phone:</span> <span className="text-neutral-700">{community.contact_phone || "—"}</span></div>
          <div><span className="text-neutral-400">Created:</span> <span className="text-neutral-700">{new Date(community.created_at).toLocaleDateString()}</span></div>
        </div>
        {community.tags && community.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {community.tags.map((t, i) => (
              <span key={i} className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs text-neutral-600">{t}</span>
            ))}
          </div>
        )}
        {community.rules && (
          <div className="mt-4">
            <p className="text-sm font-medium text-neutral-700">Rules</p>
            <p className="mt-1 text-sm text-neutral-500 whitespace-pre-wrap">{community.rules}</p>
          </div>
        )}
      </div>

      {owner && (
        <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
          <h4 className="text-sm font-semibold text-neutral-900">Owner</h4>
          <div className="mt-3 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#C2185B]/20 text-sm font-bold text-[#C2185B]">
              {owner.email?.charAt(0).toUpperCase() || "O"}
            </div>
            <div>
              <p className="text-sm font-medium text-neutral-700">{owner.first_name} {owner.last_name}</p>
              <p className="text-xs text-neutral-400">{owner.email}</p>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
        <h4 className="text-sm font-semibold text-neutral-900">Members ({members.length})</h4>
        {members.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">No members.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200">
                  <th className="px-3 py-2 font-medium text-neutral-600">Email</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Role</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Joined</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={`${m.community_id}-${m.user_id}`} className="border-b border-neutral-100">
                    <td className="px-3 py-2 text-neutral-700">{m.email || "—"}</td>
                    <td className="px-3 py-2">
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">{m.role}</span>
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{new Date(m.joined_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
        <h4 className="text-sm font-semibold text-neutral-900">Events ({events.length})</h4>
        {events.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">No events.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200">
                  <th className="px-3 py-2 font-medium text-neutral-600">Title</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Date</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Status</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Registrations</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-neutral-100">
                    <td className="px-3 py-2">
                      <Link to={`/events/${e.id}`} className="font-medium text-[#C2185B] hover:text-[#A0174A]">{e.title}</Link>
                    </td>
                    <td className="px-3 py-2 text-neutral-600">{new Date(e.start_date).toLocaleDateString()}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        e.status === "published" ? "bg-green-100 text-green-700" :
                        e.status === "cancelled" ? "bg-red-100 text-red-700" :
                        e.status === "completed" ? "bg-blue-100 text-blue-700" :
                        "bg-yellow-100 text-yellow-700"
                      }`}>{e.status}</span>
                    </td>
                    <td className="px-3 py-2 text-neutral-600">{e.booked_count}/{e.capacity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-strong">
            <h4 className="text-sm font-semibold text-neutral-900">Delete Community</h4>
            <p className="mt-2 text-sm text-neutral-500">Permanently delete {community.name}? All events, memberships, and data will be removed.</p>
            <div className="mt-4 flex justify-end gap-3">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="rounded-lg border border-neutral-200 px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting && (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
