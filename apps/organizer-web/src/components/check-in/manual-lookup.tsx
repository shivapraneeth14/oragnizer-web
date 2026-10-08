import { useState } from "react"
import { supabase } from "../../supabase"

interface Registration {
  id: string
  user_id: string
  status: string
  qr_code: string | null
  profiles: { email: string; first_name: string; last_name: string; username: string }[] | null
}

interface Props {
  eventId: string | null
  communityId: string | undefined
  onCheckIn: (qrCode: string) => void
}

export default function ManualLookup({ eventId, communityId, onCheckIn }: Props) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Registration[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)

  async function handleSearch() {
    if (!query.trim()) return
    setSearching(true)
    setSearched(true)

    let queryBuilder = supabase
      .from("registrations")
      .select("id, user_id, status, qr_code, profiles(email, first_name, last_name, username), events!inner(community_id)")
      .is("deleted_at", null)
      .in("status", ["confirmed", "attended"])

    if (eventId) {
      queryBuilder = queryBuilder.eq("event_id", eventId)
    } else if (communityId) {
      queryBuilder = queryBuilder.eq("events.community_id", communityId)
    }

    const { data: regs } = await queryBuilder

    if (!regs) { setResults([]); setSearching(false); return }

    const filtered = regs.filter(r => {
      const profile = r.profiles?.[0]
      const name = `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim().toLowerCase()
      const username = profile?.username?.toLowerCase() || ""
      const email = profile?.email?.toLowerCase() || ""
      const q = query.toLowerCase()
      return name.includes(q) || username.includes(q) || email.includes(q) || r.id.toLowerCase().includes(q)
    })

    setResults(filtered.slice(0, 10))
    setSearching(false)
  }

  function handleCheckIn(reg: Registration) {
    if (reg.qr_code) {
      onCheckIn(reg.qr_code)
    }
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-neutral-700 mb-3">Manual Lookup</h3>
      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="Search by name, email, or booking ID..."
          className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {searching ? "Searching..." : "Search"}
        </button>
      </div>

      {searched && results.length === 0 && !searching && (
        <p className="text-sm text-neutral-500 text-center py-4">No registrations found</p>
      )}

      {results.length > 0 && (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {results.map(r => (
            <div key={r.id} className="flex items-center justify-between rounded-lg border border-neutral-100 bg-neutral-50 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-neutral-800 truncate">
                  {[r.profiles?.[0]?.first_name, r.profiles?.[0]?.last_name].filter(Boolean).join(" ") || r.profiles?.[0]?.username || "Unknown"}
                </p>
                <p className="text-xs text-neutral-500 truncate">{r.profiles?.[0]?.email}</p>
                <p className="text-xs text-neutral-400">#{r.id.split("-")[0]}</p>
              </div>
              <button
                onClick={() => handleCheckIn(r)}
                disabled={!r.qr_code || r.status === "attended"}
                className="ml-3 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {r.status === "attended" ? "Checked In" : "Check In"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
