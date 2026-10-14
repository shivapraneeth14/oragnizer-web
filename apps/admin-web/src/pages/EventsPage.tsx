import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { supabase } from "../supabase"
import type { Event, Community } from "shared"

export default function EventsPage() {
  const [events, setEvents] = useState<(Event & { community_name?: string })[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from("events")
      .select("*, communities!inner(name)")
      .order("start_date", { ascending: false })
      .then(({ data }) => {
        if (data) {
          setEvents(
            data.map((e: any) => ({
              ...e,
              community_name: e.communities?.name,
            }))
          )
        }
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
      <h3 className="text-xl font-semibold text-neutral-900">All Events</h3>
      <p className="mt-2 text-sm text-neutral-500">Browse all events across every community.</p>

      {events.length === 0 ? (
        <div className="mt-8 rounded-xl border border-neutral-200 bg-white p-8 text-center">
          <p className="text-sm text-neutral-500">No events yet.</p>
        </div>
      ) : (
        <>
          <div className="mt-6 space-y-3 md:hidden">
            {events.map((e) => (
              <Link key={e.id} to={`/events/${e.id}`} className="block rounded-xl border border-neutral-200 bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-cluvo-primary">{e.title}</span>
                  <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    e.status === "published" ? "bg-green-100 text-green-700" :
                    e.status === "cancelled" ? "bg-red-100 text-red-700" :
                    e.status === "completed" ? "bg-blue-100 text-blue-700" :
                    "bg-yellow-100 text-yellow-700"
                  }`}>{e.status}</span>
                </div>
                <dl className="mt-3 space-y-1 text-xs text-neutral-500">
                  <div className="flex justify-between gap-3">
                    <dt>Community</dt>
                    <dd className="truncate text-neutral-700">{e.community_name || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Date</dt>
                    <dd className="text-neutral-700">{new Date(e.start_date).toLocaleDateString()}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Capacity</dt>
                    <dd className="text-neutral-700">{e.capacity}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Booked</dt>
                    <dd className="text-neutral-700">{e.booked_count}</dd>
                  </div>
                </dl>
              </Link>
            ))}
          </div>

          <div className="mt-6 hidden overflow-x-auto rounded-xl border border-neutral-200 bg-white md:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50">
                  <th className="px-4 py-3 font-medium text-neutral-600">Title</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Community</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Date</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Status</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Capacity</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Booked</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-neutral-100 transition-colors hover:bg-neutral-50">
                    <td className="px-4 py-3">
                      <Link to={`/events/${e.id}`} className="font-medium text-cluvo-primary hover:text-cluvo-primary-dark">
                        {e.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-neutral-600">{e.community_name || "—"}</td>
                    <td className="px-4 py-3 text-neutral-600">{new Date(e.start_date).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        e.status === "published" ? "bg-green-100 text-green-700" :
                        e.status === "cancelled" ? "bg-red-100 text-red-700" :
                        e.status === "completed" ? "bg-blue-100 text-blue-700" :
                        "bg-yellow-100 text-yellow-700"
                      }`}>{e.status}</span>
                    </td>
                    <td className="px-4 py-3 text-neutral-600">{e.capacity}</td>
                    <td className="px-4 py-3 text-neutral-600">{e.booked_count}</td>
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
