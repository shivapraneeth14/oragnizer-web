import { useEffect, useState } from "react"
import { useParams, Link } from "react-router-dom"
import { supabase } from "../supabase"
import { fetchAdminProfiles, type AdminProfile } from "../lib/admin-profiles"
import type { Event, Registration, Payment } from "shared"

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [event, setEvent] = useState<Event | null>(null)
  const [organizer, setOrganizer] = useState<AdminProfile | null>(null)
  const [registrations, setRegistrations] = useState<(Registration & { user_email?: string })[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    Promise.all([
      supabase.from("events").select("*").eq("id", id).single(),
      supabase.from("registrations").select("*").eq("event_id", id).order("registered_at"),
      supabase.from("payments").select("*, registrations!inner(event_id)").eq("registrations.event_id", id),
      fetchAdminProfiles(),
    ]).then(([eRes, rRes, pRes, profiles]) => {
      const ev = eRes.data as Event | null
      setEvent(ev)
      const byId = new Map(profiles.map((p) => [p.id, p]))
      if (ev && ev.created_by) {
        setOrganizer(byId.get(ev.created_by) ?? null)
      }
      setRegistrations((rRes.data as any[] || []).map((r) => ({ ...r, user_email: byId.get(r.user_id)?.email })))
      setPayments((pRes.data as Payment[]) || [])
      setLoading(false)
    }, () => setLoading(false))
  }, [id])

  const totalRevenue = payments
    .filter((p) => p.status === "success")
    .reduce((sum, p) => sum + p.amount, 0)

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

  if (!event) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center">
        <p className="text-sm text-neutral-500">Event not found.</p>
        <Link to="/events" className="mt-2 inline-block text-sm font-medium text-cluvo-primary">Back to Events</Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Link to="/events" className="text-sm text-neutral-500 hover:text-cluvo-primary">&larr; Back to Events</Link>

      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-soft sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold text-neutral-900">{event.title}</h3>
            <p className="mt-1 text-sm text-neutral-500">{event.description || "No description"}</p>
          </div>
          <span className={`shrink-0 self-start rounded-full px-3 py-1 text-xs font-medium ${
            event.status === "published" ? "bg-green-100 text-green-700" :
            event.status === "cancelled" ? "bg-red-100 text-red-700" :
            event.status === "completed" ? "bg-blue-100 text-blue-700" :
            "bg-yellow-100 text-yellow-700"
          }`}>{event.status}</span>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div><span className="text-neutral-400">Start:</span> <span className="text-neutral-700">{event.start_date ? new Date(event.start_date).toLocaleString() : "—"}</span></div>
          <div><span className="text-neutral-400">End:</span> <span className="text-neutral-700">{event.end_date ? new Date(event.end_date).toLocaleString() : "—"}</span></div>
          <div><span className="text-neutral-400">Location:</span> <span className="text-neutral-700">{event.location || "—"}</span></div>
          <div><span className="text-neutral-400">Capacity:</span> <span className="text-neutral-700">{event.capacity ?? "—"}</span></div>
          <div><span className="text-neutral-400">Booked:</span> <span className="text-neutral-700">{event.booked_count}</span></div>
          <div><span className="text-neutral-400">Price:</span> <span className="text-neutral-700">₹{((event.price || 0) / 100).toFixed(2)}</span></div>
        </div>
      </div>

      {organizer && (
        <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-soft sm:p-6">
          <h4 className="text-sm font-semibold text-neutral-900">Organizer</h4>
          <div className="mt-3 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cluvo-primary/20 text-sm font-bold text-cluvo-primary">
              {organizer.email?.charAt(0).toUpperCase() || "O"}
            </div>
            <div>
              <p className="text-sm font-medium text-neutral-700">{organizer.first_name} {organizer.last_name}</p>
              <p className="text-xs text-neutral-400">{organizer.email}</p>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-soft sm:p-6">
        <h4 className="text-sm font-semibold text-neutral-900">Revenue (gross, incl. platform fees)</h4>
        <p className="mt-2 text-2xl font-bold text-neutral-900">₹{(totalRevenue / 100).toFixed(2)}</p>
        <p className="text-xs text-neutral-400">{payments.filter((p) => p.status === "success").length} successful payments</p>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-soft sm:p-6">
        <h4 className="text-sm font-semibold text-neutral-900">Registrations ({registrations.length})</h4>
        {registrations.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">No registrations.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200">
                  <th className="px-3 py-2 font-medium text-neutral-600">User</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Status</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Checked In</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Registered</th>
                </tr>
              </thead>
              <tbody>
                {registrations.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100">
                    <td className="px-3 py-2 text-neutral-700">{r.user_email || "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        r.status === "confirmed" ? "bg-green-100 text-green-700" :
                        r.status === "cancelled" ? "bg-red-100 text-red-700" :
                        r.status === "attended" ? "bg-blue-100 text-blue-700" :
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
    </div>
  )
}
