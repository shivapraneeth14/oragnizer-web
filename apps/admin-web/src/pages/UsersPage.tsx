import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { fetchAdminProfiles, type AdminProfile } from "../lib/admin-profiles"
import { daysRemaining } from "../lib/deletion"

type UserFilter = "active" | "scheduled" | "deleted" | "all"

const FILTERS: { key: UserFilter; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "scheduled", label: "Scheduled" },
  { key: "deleted", label: "Suspended" },
  { key: "all", label: "All" },
]

function StatusBadge({ user }: { user: AdminProfile }) {
  if (user.deleted_at) {
    return (
      <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">Suspended</span>
    )
  }
  if (user.deletion_grace_started_at) {
    const days = daysRemaining(user.deletion_grace_started_at)
    return (
      <span className="rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-600">
        Deletion scheduled · {days}d left
      </span>
    )
  }
  return <span className="text-neutral-400">—</span>
}

export default function UsersPage() {
  const [users, setUsers] = useState<AdminProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<UserFilter>("active")

  const load = useCallback((f: UserFilter) => {
    setLoading(true)
    fetchAdminProfiles(undefined, {
      includeDeleted: f === "all",
      deletedOnly: f === "deleted",
      scheduledOnly: f === "scheduled",
    }).then((profiles) => {
      setUsers(profiles)
      setLoading(false)
    }, () => setLoading(false))
  }, [])

  useEffect(() => {
    load(filter)
  }, [filter, load])

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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-xl font-semibold text-neutral-900">All Users</h3>
          <p className="mt-2 text-sm text-neutral-500">View and manage all registered users.</p>
        </div>
        <div className="flex items-center gap-1 self-start rounded-lg border border-neutral-200 bg-white p-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f.key
                  ? "bg-cluvo-primary text-white"
                  : "text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {users.length === 0 ? (
        <div className="mt-8 rounded-xl border border-neutral-200 bg-white p-8 text-center">
          <p className="text-sm text-neutral-500">
            {filter === "scheduled" ? "No users scheduled for deletion." : filter === "deleted" ? "No suspended users." : filter === "all" ? "No users yet." : "No active users."}
          </p>
        </div>
      ) : (
        <>
          <div className="mt-6 space-y-3 md:hidden">
            {users.map((u) => (
              <Link key={u.id} to={`/users/${u.id}`} className="block rounded-xl border border-neutral-200 bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-cluvo-primary">{u.first_name} {u.last_name}</span>
                  <div className="flex items-center gap-1">
                    {u.is_admin && (
                      <span className="rounded-full bg-cluvo-primary/10 px-2 py-0.5 text-xs font-medium text-cluvo-primary">Admin</span>
                    )}
                    {u.deleted_at && (
                      <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">Suspended</span>
                    )}
                    {!u.deleted_at && u.deletion_grace_started_at && (
                      <span className="rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-600">
                        Deletion scheduled · {daysRemaining(u.deletion_grace_started_at)}d left
                      </span>
                    )}
                  </div>
                </div>
                <dl className="mt-3 space-y-1 text-xs text-neutral-500">
                  <div className="flex justify-between gap-3">
                    <dt>Email</dt>
                    <dd className="truncate text-neutral-700">{u.email}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Username</dt>
                    <dd className="text-neutral-700">{u.username || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Joined</dt>
                    <dd className="text-neutral-700">{new Date(u.created_at).toLocaleDateString()}</dd>
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
                  <th className="px-4 py-3 font-medium text-neutral-600">Email</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Username</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Admin</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Status</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Joined</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-neutral-100 transition-colors hover:bg-neutral-50">
                    <td className="px-4 py-3">
                      <Link to={`/users/${u.id}`} className="font-medium text-cluvo-primary hover:text-cluvo-primary-dark">
                        {u.first_name} {u.last_name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-neutral-600">{u.email}</td>
                    <td className="px-4 py-3 text-neutral-600">{u.username || "—"}</td>
                    <td className="px-4 py-3">
                      {u.is_admin ? (
                        <span className="rounded-full bg-cluvo-primary/10 px-2 py-0.5 text-xs font-medium text-cluvo-primary">Yes</span>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge user={u} />
                    </td>
                    <td className="px-4 py-3 text-neutral-600">{new Date(u.created_at).toLocaleDateString()}</td>
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
