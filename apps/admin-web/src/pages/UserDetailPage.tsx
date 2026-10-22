import { useCallback, useEffect, useState } from "react"
import { useParams, Link } from "react-router-dom"
import { supabase } from "../supabase"
import { fetchAdminProfiles, type AdminProfile } from "../lib/admin-profiles"
import { daysRemaining, deletionDueAt } from "../lib/deletion"
import type { Community, CommunityMember, Registration, Event } from "shared"

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [profile, setProfile] = useState<AdminProfile | null>(null)
  const [ownedCommunities, setOwnedCommunities] = useState<Community[]>([])
  const [memberships, setMemberships] = useState<(CommunityMember & { community_name?: string })[]>([])
  const [registrations, setRegistrations] = useState<(Registration & { event_title?: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmGrace, setConfirmGrace] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [actionError, setActionError] = useState("")

  const loadProfile = useCallback(async () => {
    if (!id) return
    const adminProfiles = await fetchAdminProfiles(id)
    setProfile(adminProfiles[0] ?? null)
  }, [id])

  useEffect(() => {
    if (!id) return
    Promise.all([
      fetchAdminProfiles(id),
      supabase.from("communities").select("*").eq("owner_id", id).order("created_at", { ascending: false }),
      supabase.from("community_members").select("*, communities!inner(name)").eq("user_id", id).order("joined_at", { ascending: false }),
      supabase.from("registrations").select("*, events!inner(title)").eq("user_id", id).order("registered_at", { ascending: false }),
    ]).then(([adminProfiles, oRes, mRes, rRes]) => {
      setProfile(adminProfiles[0] ?? null)
      setOwnedCommunities((oRes.data as Community[]) || [])
      setMemberships((mRes.data as any[] || []).map((m) => ({ ...m, community_name: m.communities?.name })))
      setRegistrations((rRes.data as any[] || []).map((r) => ({ ...r, event_title: r.events?.title })))
      setLoading(false)
    }, () => setLoading(false))
  }, [id])

  const handleDelete = async () => {
    if (!id) return
    setDeleting(true)
    setActionError("")
    const { data: { session } } = await supabase.auth.getSession()
    const { supabaseFetch } = await import("../supabase-fetch")
    const res = await supabaseFetch("/functions/v1/admin-delete-user", session?.access_token, { user_id: id })
    const result = await res.json()
    setDeleting(false)
    if (result.success) {
      setConfirmDelete(false)
      await loadProfile()
    } else {
      setActionError(result.error || "Something went wrong.")
    }
  }

  const handleScheduleDeletion = async () => {
    if (!id) return
    setScheduling(true)
    setActionError("")
    const { data: { session } } = await supabase.auth.getSession()
    const { supabaseFetch } = await import("../supabase-fetch")
    const res = await supabaseFetch("/functions/v1/admin-delete-user", session?.access_token, {
      user_id: id,
      mode: "grace",
    })
    const result = await res.json()
    setScheduling(false)
    if (result.success) {
      setConfirmGrace(false)
      await loadProfile()
    } else {
      setActionError(result.error || "Something went wrong.")
    }
  }

  const handleRestore = async () => {
    if (!id) return
    setRestoring(true)
    setActionError("")
    const { data: { session } } = await supabase.auth.getSession()
    const { supabaseFetch } = await import("../supabase-fetch")
    const res = await supabaseFetch("/functions/v1/admin-undelete-user", session?.access_token, { user_id: id })
    const result = await res.json()
    setRestoring(false)
    if (result.success) {
      await loadProfile()
    } else {
      setActionError(result.error || "Something went wrong.")
    }
  }

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

  if (!profile) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center">
        <p className="text-sm text-neutral-500">User not found.</p>
        <Link to="/users" className="mt-2 inline-block text-sm font-medium text-cluvo-primary">Back to Users</Link>
      </div>
    )
  }

  const isDeleted = Boolean(profile.deleted_at)
  const isGrace = !isDeleted && Boolean(profile.deletion_grace_started_at)

  return (
    <div className="space-y-6">
      <Link to="/users" className="text-sm text-neutral-500 hover:text-cluvo-primary">&larr; Back to Users</Link>

      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-soft sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-cluvo-primary/20 text-lg font-bold text-cluvo-primary">
              {profile.email?.charAt(0).toUpperCase() || "U"}
            </div>
            <div className="min-w-0">
              <h3 className="text-xl font-semibold text-neutral-900">{profile.first_name} {profile.last_name}</h3>
              <p className="truncate text-sm text-neutral-500">{profile.email}</p>
              <p className="text-xs text-neutral-400">@{profile.username || "—"}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 sm:ml-auto">
            {profile.is_admin && (
              <span className="rounded-full bg-cluvo-primary/10 px-3 py-1 text-xs font-medium text-cluvo-primary">Admin</span>
            )}
            {isDeleted && (
              <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-600">Suspended</span>
            )}
            {isGrace && (
              <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-600">
                Deletion scheduled · {daysRemaining(profile.deletion_grace_started_at!)}d left
              </span>
            )}
            {isDeleted || isGrace ? (
              <button
                onClick={handleRestore}
                disabled={restoring}
                className="rounded-lg bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-50"
              >
                {restoring ? "Restoring..." : isGrace ? "Cancel deletion" : "Restore"}
              </button>
            ) : (
              <>
                <button
                  onClick={() => { setConfirmDelete(true); setActionError("") }}
                  className="rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100"
                >
                  Suspend
                </button>
                {!isGrace && (
                  <button
                    onClick={() => { setConfirmGrace(true); setActionError("") }}
                    className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                  >
                    Schedule deletion
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        <div className="mt-4 text-sm text-neutral-500">
          Joined {new Date(profile.created_at).toLocaleDateString()}
          {isDeleted && (
            <span className="ml-2 text-red-600">· Suspended {new Date(profile.deleted_at!).toLocaleDateString()}</span>
          )}
          {isGrace && (
            <span className="ml-2 text-orange-600">
              · Deletion scheduled {new Date(profile.deletion_grace_started_at!).toLocaleDateString()} ·{" "}
              {daysRemaining(profile.deletion_grace_started_at!)} days left (purges{" "}
              {deletionDueAt(profile.deletion_grace_started_at!).toLocaleDateString()})
            </span>
          )}
        </div>
        {actionError && (
          <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{actionError}</div>
        )}
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-soft sm:p-6">
        <h4 className="text-sm font-semibold text-neutral-900">Owned Communities ({ownedCommunities.length})</h4>
        {ownedCommunities.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">No owned communities.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {ownedCommunities.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-neutral-100 px-4 py-3">
                <Link to={`/communities/${c.id}`} className="text-sm font-medium text-cluvo-primary hover:text-cluvo-primary-dark">{c.name}</Link>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-soft sm:p-6">
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
                    <td className="px-3 py-2 text-sm font-medium text-cluvo-primary">{m.community_name || "—"}</td>
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

      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-soft sm:p-6">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-xl bg-white p-5 shadow-strong sm:p-6">
            <h4 className="text-sm font-semibold text-neutral-900">Suspend User</h4>
            <p className="mt-2 text-sm text-neutral-500">
              Suspend {profile.first_name} {profile.last_name} ({profile.email})? They will no longer be able to sign in. This is reversible with Restore.
            </p>
            {actionError && (
              <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{actionError}</div>
            )}
            <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="w-full rounded-lg border border-neutral-200 px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-50 sm:w-auto"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50 sm:w-auto"
              >
                {deleting && (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {deleting ? "Suspending..." : "Suspend"}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmGrace && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-5 shadow-strong sm:p-6">
            <h4 className="text-sm font-semibold text-neutral-900">Schedule Account Deletion</h4>
            <p className="mt-2 text-sm text-neutral-500">
              Schedule {profile.first_name} {profile.last_name} ({profile.email}) for permanent deletion.
              They have a 30-day grace period and can still log in to cancel. After 30 days their profile
              and personal content are permanently deleted; financial records are retained unlinked.
            </p>
            <p className="mt-2 text-xs text-orange-600">
              This is irreversible once the grace period expires. For a reversible block, use Suspend instead.
            </p>
            {actionError && (
              <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{actionError}</div>
            )}
            <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                onClick={() => setConfirmGrace(false)}
                disabled={scheduling}
                className="w-full rounded-lg border border-neutral-200 px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-50 sm:w-auto"
              >
                Cancel
              </button>
              <button
                onClick={handleScheduleDeletion}
                disabled={scheduling}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50 sm:w-auto"
              >
                {scheduling ? "Scheduling..." : "Schedule deletion"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
