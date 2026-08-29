import { useEffect } from "react"

export interface ScanResult {
  success: boolean
  message: string
  attendee_name?: string
  event_title?: string
  already_checked_in?: boolean
}

interface Props {
  result: ScanResult | null
  onDismiss: () => void
}

export default function ScanResultOverlay({ result, onDismiss }: Props) {
  useEffect(() => {
    if (!result) return
    const timer = setTimeout(onDismiss, result.success ? 4000 : 3000)
    return () => clearTimeout(timer)
  }, [result, onDismiss])

  if (!result) return null

  const isAlreadyScanned = result.already_checked_in
  const bgColor = result.success && !isAlreadyScanned
    ? "bg-green-500"
    : isAlreadyScanned
      ? "bg-yellow-500"
      : "bg-red-500"

  const icon = result.success && !isAlreadyScanned
    ? "✅"
    : isAlreadyScanned
      ? "⚠️"
      : "❌"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onDismiss}>
      <div
        className={`${bgColor} rounded-2xl p-8 text-white text-center max-w-sm mx-4 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-5xl mb-4">{icon}</div>
        <h3 className="text-xl font-bold mb-2">
          {result.success && !isAlreadyScanned ? "Checked In" : isAlreadyScanned ? "Already Scanned" : "Failed"}
        </h3>
        <p className="text-sm opacity-90 mb-1">{result.message}</p>
        {result.attendee_name && (
          <p className="text-lg font-semibold mt-2">{result.attendee_name}</p>
        )}
        {result.event_title && (
          <p className="text-sm opacity-75">{result.event_title}</p>
        )}
        <p className="text-xs opacity-50 mt-4">Tap anywhere to dismiss</p>
      </div>
    </div>
  )
}
