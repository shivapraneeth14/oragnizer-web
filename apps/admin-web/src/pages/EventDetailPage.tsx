import { useEffect, useState } from "react"
import { useParams, Link } from "react-router-dom"
import { supabase } from "../supabase"
import type { Event, Profile, Registration, Payment } from "shared"

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [event, setEvent] = useState<Event | null>(null)
  const [organizer, setOrganizer] = useState<Profile | null>(null)
  const [registrations, setRegistrations] = useState<(Registration & { user_email?: string })[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    Promise.all([
      supabase.from("events").select("*, profiles!created_by(email)").eq("id", id).single(),
      supabase.from("registrations").select("*, profiles!inner(email)").eq("event_id", id).order("registered_at"),
      supabase.from("payments").select("*, registrations!inner(event_id)").eq("registrations.event_id", id),
    ]).then(([eRes, rRes, pRes]) => {
      const ev = eRes.data as any
      setEvent(ev)
      if (ev && ev.created_by) {
        supabase.from("profiles").select("*").eq("id", ev.created_by).single().then(({ data: o }) => setOrganizer(o as Profile))
      }
      setRegistrations((rRes.data as any[] || []).map((r) => ({ ...r, user_email: r.profiles?.email })))
      setPayments((pRes.data as Payment[]) || [])
      setLoading(false)
    })
  }, [id])

  const totalRevenue = payments
    .filter((p) => p.status === "success")
    .reduce((sum, p) => sum + p.amount, 0)

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

  if (!event) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center">
        <p className="text-sm text-neutral-500">Event not found.</p>
        <Link to="/events" className="mt-2 inline-block text-sm font-medium text-[#C2185B]">Back to Events</Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Link to="/events" className="text-sm text-neutral-500 hover:text-[#C2185B]">&larr; Back to Events</Link>

      <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-xl font-semibold text-neutral-900">{event.title}</h3>
            <p className="mt-1 text-sm text-neutral-500">{event.description || "No description"}</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${
            event.status === "published" ? "bg-green-100 text-green-700" :
            event.status === "cancelled" ? "bg-red-100 text-red-700" :
            event.status === "completed" ? "bg-blue-100 text-blue-700" :
            "bg-yellow-100 text-yellow-700"
          }`}>{event.status}</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm lg:grid-cols-3">
          <div><span className="text-neutral-400">Start:</span> <span className="text-neutral-700">{event.start_date ? new Date(event.start_date).toLocaleString() : "—"}</span></div>
          <div><span className="text-neutral-400">End:</span> <span className="text-neutral-700">{event.end_date ? new Date(event.end_date).toLocaleString() : "—"}</span></div>
          <div><span className="text-neutral-400">Location:</span> <span className="text-neutral-700">{event.location || "—"}</span></div>
          <div><span className="text-neutral-400">Capacity:</span> <span className="text-neutral-700">{event.capacity ?? "—"}</span></div>
          <div><span className="text-neutral-400">Booked:</span> <span className="text-neutral-700">{event.booked_count}</span></div>
          <div><span className="text-neutral-400">Price:</span> <span className="text-neutral-700">₹{((event.price || 0) / 100).toFixed(2)}</span></div>
        </div>
      </div>

      {organizer && (
        <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
          <h4 className="text-sm font-semibold text-neutral-900">Organizer</h4>
          <div className="mt-3 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#C2185B]/20 text-sm font-bold text-[#C2185B]">
              {organizer.email?.charAt(0).toUpperCase() || "O"}
            </div>
            <div>
              <p className="text-sm font-medium text-neutral-700">{organizer.first_name} {organizer.last_name}</p>
              <p className="text-xs text-neutral-400">{organizer.email}</p>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
        <h4 className="text-sm font-semibold text-neutral-900">Revenue</h4>
        <p className="mt-2 text-2xl font-bold text-neutral-900">₹{(totalRevenue / 100).toFixed(2)}</p>
        <p className="text-xs text-neutral-400">{payments.filter((p) => p.status === "success").length} successful payments</p>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
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
