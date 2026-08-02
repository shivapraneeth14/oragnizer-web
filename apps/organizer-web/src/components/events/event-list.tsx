import { useState } from "react"
import { copyText } from "../../lib/clipboard"
import { shareBase } from "../../lib/share"
import type { Event } from "shared"

interface Props {
  events: Event[]
  loading: boolean
  loadingMore?: boolean
  hasMore?: boolean
  error?: string | null
  onLoadMore?: () => void
  onView: (event: Event) => void
  onEdit: (event: Event) => void
  onCancel: (id: string) => void
  onCreate: () => void
  onRetry?: () => void
}

type Filter = "upcoming" | "today" | "all"

function toDateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

const statusColors: Record<string, string> = {
  draft: "bg-neutral-100 text-neutral-600",
  published: "bg-green-100 text-green-700",
  cancelled: "bg-red-100 text-red-600",
  completed: "bg-blue-100 text-blue-600",
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  })
}

const chipBase = "cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors"

export default function EventList({ events, loading, loadingMore, hasMore, error, onLoadMore, onView, onEdit, onCancel, onCreate, onRetry }: Props) {
  const [filter, setFilter] = useState<Filter>("all")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [search, setSearch] = useState("")
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const filtered = events.filter((e) => {
    if (search.trim() && !e.title.toLowerCase().includes(search.trim().toLowerCase()))
      return false
    if (fromDate && toDate) {
      const start = new Date(e.start_date)
      return start >= new Date(fromDate) && start <= new Date(toDate + "T23:59:59")
    }
    const eventDay = toDateStr(new Date(e.start_date))
    const today = toDateStr(new Date())
    const tomorrow = toDateStr(new Date(Date.now() + 86400000))
    if (filter === "today") return eventDay === today
    if (filter === "upcoming") return eventDay >= tomorrow
    return true
  })

  const clearDateRange = () => {
    setFromDate("")
    setToDate("")
  }

  const activeRange = fromDate && toDate

  return (
    <div>
      {/* Filters + Create */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => { setFilter("all"); clearDateRange() }}
            className={`${chipBase} ${!activeRange && filter === "all" ? "bg-[#C2185B] text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}>
            All
          </button>
          <button onClick={() => { setFilter("today"); clearDateRange() }}
            className={`${chipBase} ${!activeRange && filter === "today" ? "bg-[#C2185B] text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}>
            Today
          </button>
          <button onClick={() => { setFilter("upcoming"); clearDateRange() }}
            className={`${chipBase} ${!activeRange && filter === "upcoming" ? "bg-[#C2185B] text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}>
            Upcoming
          </button>

          <span className="mx-1 text-neutral-300">|</span>

          <div className="flex items-center gap-2">
            <label className="text-xs text-neutral-500">From</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
              className="rounded-lg border border-neutral-300 px-2 py-1.5 text-xs focus:border-[#C2185B] focus:outline-none" />
            <label className="text-xs text-neutral-500">To</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
              className="rounded-lg border border-neutral-300 px-2 py-1.5 text-xs focus:border-[#C2185B] focus:outline-none" />
            {activeRange && (
              <button onClick={clearDateRange}
                className="rounded p-0.5 text-neutral-400 hover:text-red-500" title="Clear date range">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          <div className="relative flex-1 min-w-[160px] max-w-xs">
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search events..."
              className="w-full rounded-lg border border-neutral-300 py-2 pl-9 pr-3 text-sm focus:border-[#C2185B] focus:outline-none" />
          </div>
        </div>

        <button onClick={onCreate}
          className="flex items-center gap-1.5 rounded-lg bg-[#C2185B] px-4 py-2 text-sm font-medium text-white hover:bg-[#A0154A]">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Create Event
        </button>
      </div>

      <p className="mb-4 text-sm text-neutral-500">{filtered.length} event{filtered.length !== 1 ? "s" : ""}</p>

      {error && !loading ? (
        <div className="rounded-xl border border-red-200 bg-red-50 py-12 text-center">
          <svg className="mx-auto h-10 w-10 text-red-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <p className="mt-3 text-sm text-red-600">{error}</p>
          {onRetry && (
            <button onClick={onRetry} className="mt-3 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
              Retry
            </button>
          )}
        </div>
      ) : loading ? (
        <div className="flex justify-center py-16">
          <svg className="h-6 w-6 animate-spin text-[#C2185B]" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-neutral-200 py-16 text-center">
          <svg className="mx-auto h-10 w-10 text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <p className="mt-3 text-sm text-neutral-400">No events found for this filter.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((event) => (
            <div key={event.id} className="flex items-start gap-4 rounded-xl border border-neutral-200 bg-white p-4 shadow-soft">
              <button onClick={() => onView(event)} className="flex flex-1 items-start gap-4 text-left" type="button">
                <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-100">
                  {event.image_url ? (
                    <img src={event.image_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <svg className="h-6 w-6 text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-semibold text-neutral-900">{event.title}</h4>
                      <p className="mt-0.5 text-xs text-neutral-400">{formatDate(event.start_date)}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[event.status]}`}>
                      {event.status.charAt(0).toUpperCase() + event.status.slice(1)}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
                    {event.location && (
                      <span className="flex items-center gap-1">
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        {event.location}
                      </span>
                    )}
                    {event.capacity && (
                      <span>{event.booked_count || 0} / {event.capacity}</span>
                    )}
                    {event.price > 0 ? (
                      <span className="font-medium text-neutral-700">₹{event.price / 100}</span>
                    ) : (
                      <span className="text-green-600">Free</span>
                    )}
                  </div>
                </div>
              </button>

              <div className="flex shrink-0 gap-1">
                <button onClick={async (e) => {
                  e.stopPropagation()
                  const url = `${shareBase()}events/${event.id}`
                  await copyText(url)
                  setCopiedId(event.id)
                  setTimeout(() => setCopiedId(null), 2000)
                }}
                  className={`rounded-lg p-1.5 hover:bg-neutral-100 ${
                    copiedId === event.id ? "text-green-600" : "text-neutral-400 hover:text-[#C2185B]"
                  }`}
                  title={copiedId === event.id ? "Copied!" : "Copy share link"}
                >
                  {copiedId === event.id ? (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                    </svg>
                  )}
                </button>
                <button onClick={(e) => { e.stopPropagation(); onEdit(event) }}
                  className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-[#C2185B]"
                  title="Edit"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                {event.status !== "cancelled" && (
                  <button onClick={(e) => { e.stopPropagation(); onCancel(event.id) }}
                    className="rounded-lg p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-500"
                    title="Cancel event"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))}
          {hasMore && filtered.length > 0 && (
            <div className="text-center pt-2">
              <button
                onClick={onLoadMore}
                disabled={loadingMore}
                className="rounded-lg border border-neutral-300 px-6 py-2 text-sm text-neutral-600 hover:bg-neutral-100 hover:border-[#C2185B] hover:text-[#C2185B] disabled:opacity-50 transition-colors"
              >
                {loadingMore ? 'Loading...' : 'Load More'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
