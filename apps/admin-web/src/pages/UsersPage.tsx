import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { fetchAdminProfiles, type AdminProfile } from "../lib/admin-profiles"

export default function UsersPage() {
  const [users, setUsers] = useState<AdminProfile[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchAdminProfiles().then((profiles) => {
      setUsers(profiles)
      setLoading(false)
    }, () => setLoading(false))
  }, [])

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
      <h3 className="text-xl font-semibold text-neutral-900">All Users</h3>
      <p className="mt-2 text-sm text-neutral-500">View and manage all registered users.</p>

      {users.length === 0 ? (
        <div className="mt-8 rounded-xl border border-neutral-200 bg-white p-8 text-center">
          <p className="text-sm text-neutral-500">No users yet.</p>
        </div>
      ) : (
        <>
          <div className="mt-6 space-y-3 md:hidden">
            {users.map((u) => (
              <Link key={u.id} to={`/users/${u.id}`} className="block rounded-xl border border-neutral-200 bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-cluvo-primary">{u.first_name} {u.last_name}</span>
                  {u.is_admin && (
                    <span className="rounded-full bg-cluvo-primary/10 px-2 py-0.5 text-xs font-medium text-cluvo-primary">Admin</span>
                  )}
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
