import { useEffect, useState } from "react"
import { useParams, Link, useNavigate } from "react-router-dom"
import { supabase } from "../supabase"
import type { Profile, Community, CommunityMember, Registration, Event } from "shared"

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [ownedCommunities, setOwnedCommunities] = useState<Community[]>([])
  const [memberships, setMemberships] = useState<(CommunityMember & { community_name?: string })[]>([])
  const [registrations, setRegistrations] = useState<(Registration & { event_title?: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteError, setDeleteError] = useState("")

  useEffect(() => {
    if (!id) return
    Promise.all([
      supabase.from("profiles").select("*").eq("id", id).single(),
      supabase.from("communities").select("*").eq("owner_id", id).order("created_at", { ascending: false }),
      supabase.from("community_members").select("*, communities!inner(name)").eq("user_id", id).order("joined_at", { ascending: false }),
      supabase.from("registrations").select("*, events!inner(title)").eq("user_id", id).order("registered_at", { ascending: false }),
    ]).then(([pRes, oRes, mRes, rRes]) => {
      setProfile(pRes.data as Profile)
      setOwnedCommunities((oRes.data as Community[]) || [])
      setMemberships((mRes.data as any[] || []).map((m) => ({ ...m, community_name: m.communities?.name })))
      setRegistrations((rRes.data as any[] || []).map((r) => ({ ...r, event_title: r.events?.title })))
      setLoading(false)
    })
  }, [id])

  const handleDelete = async () => {
    if (!id) return
    setDeleting(true)
    setDeleteError("")
    const { data: { session } } = await supabase.auth.getSession()
    const { supabaseFetch } = await import("../supabase-fetch")
    const res = await supabaseFetch("/functions/v1/admin-delete-user", session?.access_token, { user_id: id })
    const result = await res.json()
    setDeleting(false)
    if (result.success) {
      navigate("/users", { replace: true })
    } else {
      setDeleteError(result.error || "Something went wrong.")
    }
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

  if (!profile) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center">
        <p className="text-sm text-neutral-500">User not found.</p>
        <Link to="/users" className="mt-2 inline-block text-sm font-medium text-[#C2185B]">Back to Users</Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Link to="/users" className="text-sm text-neutral-500 hover:text-[#C2185B]">&larr; Back to Users</Link>

      <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#C2185B]/20 text-lg font-bold text-[#C2185B]">
            {profile.email?.charAt(0).toUpperCase() || "U"}
          </div>
          <div>
            <h3 className="text-xl font-semibold text-neutral-900">{profile.first_name} {profile.last_name}</h3>
            <p className="text-sm text-neutral-500">{profile.email}</p>
            <p className="text-xs text-neutral-400">@{profile.username || "—"}</p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {profile.is_admin && (
              <span className="rounded-full bg-[#C2185B]/10 px-3 py-1 text-xs font-medium text-[#C2185B]">Admin</span>
            )}
            <button
              onClick={() => { setConfirmDelete(true); setDeleteError("") }}
              className="rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100"
            >
              Delete
            </button>
          </div>
        </div>
        <div className="mt-4 text-sm text-neutral-500">Joined {new Date(profile.created_at).toLocaleDateString()}</div>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
        <h4 className="text-sm font-semibold text-neutral-900">Owned Communities ({ownedCommunities.length})</h4>
        {ownedCommunities.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">No owned communities.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {ownedCommunities.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-neutral-100 px-4 py-3">
                <Link to={`/communities/${c.id}`} className="text-sm font-medium text-[#C2185B] hover:text-[#A0174A]">{c.name}</Link>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
        <h4 className="text-sm font-semibold text-neutral-900">Memberships ({memberships.length})</h4>
        {memberships.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">No memberships.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200">
                  <th className="px-3 py-2 font-medium text-neutral-600">Community</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Role</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Joined</th>
                </tr>
              </thead>
              <tbody>
                {memberships.map((m) => (
                  <tr key={`${m.community_id}-${m.user_id}`} className="border-b border-neutral-100">
                    <td className="px-3 py-2 text-sm font-medium text-[#C2185B]">{m.community_name || "—"}</td>
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
        <h4 className="text-sm font-semibold text-neutral-900">Event Registrations ({registrations.length})</h4>
        {registrations.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">No registrations.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200">
                  <th className="px-3 py-2 font-medium text-neutral-600">Event</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Status</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Checked In</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Registered</th>
                </tr>
              </thead>
              <tbody>
                {registrations.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100">
                    <td className="px-3 py-2 text-sm text-neutral-700">{r.event_title || "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        r.status === "confirmed" ? "bg-green-100 text-green-700" :
                        r.status === "cancelled" ? "bg-red-100 text-red-700" :
                        "bg-yellow-100 text-yellow-700"
                      }`}>{r.status}</span>
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{r.checked_in ? "Yes" : "No"}</td>
                    <td className="px-3 py-2 text-neutral-500">{new Date(r.registered_at).toLocaleDateString()}</td>
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
            <h4 className="text-sm font-semibold text-neutral-900">Delete User</h4>
            <p className="mt-2 text-sm text-neutral-500">
              Permanently delete {profile.first_name} {profile.last_name} ({profile.email})? Their profile will be hidden and their session revoked.
            </p>
            {deleteError && (
              <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{deleteError}</div>
            )}
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
