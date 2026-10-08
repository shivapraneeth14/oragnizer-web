import { useState, useEffect } from "react"
import { supabase } from "../../supabase"

interface CheckInRecord {
  id: string
  attendee_name: string
  event_title: string
  checked_in_at: string
  status: string
  qr_code: string | null
}

interface Props {
  eventId: string | null
  communityId: string | undefined
  refreshKey: number
}

function formatTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

export default function CheckInList({ eventId, communityId, refreshKey }: Props) {
  const [records, setRecords] = useState<CheckInRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")

  useEffect(() => {
    loadRecords()
  }, [eventId, communityId, refreshKey])

  async function loadRecords() {
    setLoading(true)
    let query = supabase
      .from("registrations")
      .select("id, status, checked_in, checked_in_at, qr_code, user_id, event_id, profiles(first_name, last_name, username), events!inner(title, community_id)")
      .is("deleted_at", null)
      .in("status", ["confirmed", "attended"])

    if (eventId) {
      query = query.eq("event_id", eventId)
    } else if (communityId) {
      query = query.eq("events.community_id", communityId)
    }

    const { data } = await query.order("checked_in_at", { ascending: false, nullsFirst: false }).order("registered_at", { ascending: false })

    const mapped = (data || []).map(r => ({
      id: r.id,
      attendee_name: `${r.profiles?.[0]?.first_name || ""} ${r.profiles?.[0]?.last_name || ""}`.trim() || r.profiles?.[0]?.username || "Unknown",
      event_title: r.events?.[0]?.title || "",
      checked_in_at: r.checked_in_at || "",
      status: r.status,
      qr_code: r.qr_code,
    }))

    setRecords(mapped)
    setLoading(false)
  }

  const filtered = records.filter(r => {
    if (!search) return true
    const q = search.toLowerCase()
    return r.attendee_name.toLowerCase().includes(q) || r.event_title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)
  })

  const checkedIn = records.filter(r => r.status === "attended").length

  if (loading) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center">
        <div className="animate-pulse text-neutral-400">Loading records...</div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white overflow-hidden">
      <div className="p-4 border-b border-neutral-100">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-neutral-700">Check-in Records ({checkedIn}/{records.length})</h3>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name, event, or ID..."
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="p-8 text-center text-sm text-neutral-400">
          {records.length === 0 ? "No check-in records yet" : "No matches found"}
        </div>
      ) : (
        <div className="divide-y divide-neutral-100 max-h-96 overflow-y-auto">
          {filtered.map(r => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-3 hover:bg-neutral-50 transition-colors">
              <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm ${
                r.status === "attended" ? "bg-green-100 text-green-600" : "bg-neutral-100 text-neutral-500"
              }`}>
                {r.status === "attended" ? "✓" : "○"}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-neutral-800 truncate">{r.attendee_name}</p>
                <p className="text-xs text-neutral-500 truncate">{r.event_title}</p>
              </div>
              <div className="text-right flex-shrink-0">
                {r.checked_in_at ? (
                  <p className="text-xs text-green-600 font-medium">{formatTime(r.checked_in_at)}</p>
                ) : (
                  <p className="text-xs text-neutral-400">Not checked in</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
