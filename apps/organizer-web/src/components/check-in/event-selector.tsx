import { useState, useEffect } from "react"
import { supabase } from "../../supabase"

export interface EventOption {
  id: string
  title: string
  start_date: string
  total: number
  checked_in: number
}

interface Props {
  selectedEventId: string | null
  onSelect: (eventId: string | null) => void
  communityId: string | undefined
  onEventsLoad?: (events: EventOption[]) => void
}

export default function EventSelector({ selectedEventId, onSelect, communityId, onEventsLoad }: Props) {
  const [events, setEvents] = useState<EventOption[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!communityId) return
    loadEvents()
  }, [communityId])

  async function loadEvents() {
    setLoading(true)
    const { data: evts } = await supabase
      .from("events")
      .select("id, title, start_date")
      .eq("community_id", communityId!)
      .is("deleted_at", null)
      .order("start_date", { ascending: false })

    if (!evts) { setLoading(false); return }

    const eventIds = evts.map(e => e.id)
    const { data: regs } = await supabase
      .from("registrations")
      .select("event_id, checked_in")
      .in("event_id", eventIds)
      .is("deleted_at", null)
      .in("status", ["confirmed", "attended"])

    const stats: Record<string, { total: number; checked_in: number }> = {}
    for (const r of regs || []) {
      if (!stats[r.event_id]) stats[r.event_id] = { total: 0, checked_in: 0 }
      stats[r.event_id].total++
      if (r.checked_in) stats[r.event_id].checked_in++
    }

    const mapped = evts.map(e => ({
      id: e.id,
      title: e.title,
      start_date: e.start_date,
      total: stats[e.id]?.total || 0,
      checked_in: stats[e.id]?.checked_in || 0,
    }))

    setEvents(mapped)
    setLoading(false)
    onEventsLoad?.(mapped)
  }

  const totalAll = events.reduce((s, e) => s + e.total, 0)
  const checkedAll = events.reduce((s, e) => s + e.checked_in, 0)

  return (
    <select
      value={selectedEventId || ""}
      onChange={(e) => onSelect(e.target.value || null)}
      className="rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      disabled={loading}
    >
      <option value="">All Events ({checkedAll}/{totalAll})</option>
      {events.map(e => (
        <option key={e.id} value={e.id}>
          {e.title} ({e.checked_in}/{e.total})
        </option>
      ))}
    </select>
  )
}
