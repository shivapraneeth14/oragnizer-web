import { useState, useCallback } from "react"
import { supabase } from "../supabase"
import EventSelector, { type EventOption } from "../components/check-in/event-selector"
import StatsCards from "../components/check-in/stats-cards"
import CheckInList from "../components/check-in/check-in-list"
import ScanModal from "../components/check-in/scan-modal"
import ScanResultOverlay, { type ScanResult } from "../components/check-in/scan-result"
import ManualLookup from "../components/check-in/manual-lookup"

export default function CheckInPage({ communityId }: { communityId: string | undefined }) {
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [events, setEvents] = useState<EventOption[]>([])
  const [scanning, setScanning] = useState(false)

  const stats = (() => {
    if (!selectedEventId) {
      return {
        total: events.reduce((s, e) => s + e.total, 0),
        checkedIn: events.reduce((s, e) => s + e.checked_in, 0),
      }
    }
    const evt = events.find(e => e.id === selectedEventId)
    return { total: evt?.total || 0, checkedIn: evt?.checked_in || 0 }
  })()

  const handleScan = useCallback(async (qrCode: string) => {
    setScanning(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/check-in`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session?.access_token}`,
          "apikey": import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ qr_code: qrCode }),
      })

      const data = await res.json()
      if (!res.ok) {
        setScanResult({ success: false, message: data.error || "Check-in failed" })
      } else {
        setScanResult({
          success: data.success,
          message: data.message,
          attendee_name: data.attendee_name,
          event_title: data.event_title,
          already_checked_in: data.already_checked_in,
        })
      }
      setRefreshKey(k => k + 1)
    } catch (err) {
      console.error("Scan error:", err)
      setScanResult({ success: false, message: "Network error — check connection and try again" })
    }
    setScanning(false)
  }, [])

  const handleManualCheckIn = useCallback(async (qrCode: string) => {
    await handleScan(qrCode)
  }, [handleScan])

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-neutral-800">Check-In</h1>
        <button
          onClick={() => setScanOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
          </svg>
          Scan
          {scanning && <span className="animate-pulse">...</span>}
        </button>
      </div>

      {/* Event filter */}
      <EventSelector
        selectedEventId={selectedEventId}
        onSelect={setSelectedEventId}
        communityId={communityId}
        onEventsLoad={setEvents}
      />

      {/* Stats */}
      <StatsCards total={stats.total} checkedIn={stats.checkedIn} loading={false} />

      {/* Manual lookup */}
      <ManualLookup eventId={selectedEventId} communityId={communityId} onCheckIn={handleManualCheckIn} />

      {/* Check-in list */}
      <CheckInList eventId={selectedEventId} communityId={communityId} refreshKey={refreshKey} />

      {/* Scan modal */}
      <ScanModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onScan={handleScan}
      />

      {/* Scan result overlay */}
      <ScanResultOverlay result={scanResult} onDismiss={() => setScanResult(null)} />
    </div>
  )
}
