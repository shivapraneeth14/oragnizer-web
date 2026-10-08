import { useEffect, useRef, useState, useCallback } from "react"
import { Html5Qrcode } from "html5-qrcode"

interface Props {
  open: boolean
  onClose: () => void
  onScan: (qrCode: string) => void
}

export default function ScanModal({ open, onClose, onScan }: Props) {
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manualEntry, setManualEntry] = useState(false)
  const [manualCode, setManualCode] = useState("")
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const stopScanner = useCallback(async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop()
        scannerRef.current.clear()
      } catch {}
      scannerRef.current = null
    }
    setScanning(false)
  }, [])

  useEffect(() => {
    if (!open) {
      stopScanner()
      setError(null)
      setManualEntry(false)
      setManualCode("")
      return
    }

    startScanner()
  }, [open, stopScanner])

  async function startScanner() {
    if (!containerRef.current) return
    setError(null)
    setScanning(true)

    try {
      const scanner = new Html5Qrcode("qr-scanner-container")
      scannerRef.current = scanner

      let cameraSpec: string | { facingMode: string } | { deviceId: string } = { facingMode: "environment" }
      try {
        const cameras = await Html5Qrcode.getCameras()
        if (cameras.length > 0) {
          cameraSpec = { deviceId: cameras[cameras.length - 1].id }
        }
      } catch {}

      await scanner.start(
        cameraSpec,
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
          aspectRatio: 1.0,
        },
        (decodedText) => {
          onScan(decodedText)
          stopScanner()
        },
        () => {}
      )
    } catch (err: any) {
      console.error("Camera error:", err)
      if (err?.toString?.().includes("Permission")) {
        setError("Camera permission denied. Use manual entry below.")
      } else if (err?.toString?.().includes("NotAllowedError")) {
        setError("Camera access denied by browser. Use manual entry below.")
      } else {
        setError("Could not start camera. Use manual entry below.")
      }
      setScanning(false)
      setManualEntry(true)
    }
  }

  function handleManualSubmit() {
    if (manualCode.trim()) {
      onScan(manualCode.trim())
      onClose()
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-white rounded-2xl overflow-hidden max-w-md w-full mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-neutral-200">
          <h3 className="text-lg font-semibold text-neutral-800">Scan QR Code</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4">
          {!manualEntry ? (
            <>
              <div
                id="qr-scanner-container"
                ref={containerRef}
                className="w-full aspect-square rounded-lg overflow-hidden bg-neutral-900 mb-4"
              />
              {scanning && (
                <p className="text-center text-sm text-neutral-500">
                  Point camera at attendee's QR code
                </p>
              )}
              {error && (
                <div className="text-center">
                  <p className="text-sm text-red-600 mb-3">{error}</p>
                  <button
                    onClick={() => setManualEntry(true)}
                    className="text-sm text-blue-600 hover:text-blue-700 underline"
                  >
                    Enter QR code manually
                  </button>
                </div>
              )}
              {!scanning && !error && (
                <button
                  onClick={startScanner}
                  className="w-full rounded-lg bg-blue-600 px-4 py-3 text-white font-medium hover:bg-blue-700 transition-colors"
                >
                  Start Camera
                </button>
              )}
            </>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-neutral-600">Enter the QR code value manually:</p>
              <input
                type="text"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleManualSubmit()}
                placeholder="QR code value..."
                className="w-full rounded-lg border border-neutral-300 px-4 py-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={handleManualSubmit}
                  disabled={!manualCode.trim()}
                  className="flex-1 rounded-lg bg-blue-600 px-4 py-3 text-white font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Check In
                </button>
                <button
                  onClick={() => { setManualEntry(false); setError(null); startScanner() }}
                  className="rounded-lg border border-neutral-300 px-4 py-3 text-neutral-600 hover:bg-neutral-50 transition-colors"
                >
                  Camera
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
