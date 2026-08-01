import { useCallback, useEffect, useRef, useState } from "react"

interface PreviewItem {
  id: string
  url: string
  thumbnail_url: string | null
  type: "image" | "video"
  caption: string | null
}

interface Props {
  item: PreviewItem | null
  onClose: () => void
}

export default function VideoPreviewModal({ item, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [buffering, setBuffering] = useState(false)
  const [error, setError] = useState(false)
  const [playing, setPlaying] = useState(false)

  const handleClose = useCallback(() => {
    const video = videoRef.current
    if (video) {
      video.pause()
      video.removeAttribute("src")
      video.load()
    }
    onClose()
  }, [onClose])

  useEffect(() => {
    if (item) {
      closeRef.current?.focus()
      setBuffering(false)
      setError(false)
      setPlaying(false)
    }
  }, [item])

  useEffect(() => {
    if (!item) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        handleClose()
      }
      if (e.key === " ") {
        const video = videoRef.current
        if (video && !video.paused) e.preventDefault()
      }
    }
    document.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = ""
    }
  }, [item, handleClose])

  if (!item) return null

  const play = () => {
    videoRef.current?.play()
  }

  const toggleFullscreen = () => {
    const video = videoRef.current
    if (!video) return
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      void video.requestFullscreen()
    }
  }

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm sm:p-8"
      onClick={handleClose}
    >
      <div
        className="animate-zoom-in w-full max-w-5xl overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 shadow-strong"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#C2185B]/15 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#E91E63]">
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              Video
            </span>
            <span className="truncate text-sm font-medium text-white">
              {item.caption || "Video preview"}
            </span>
          </div>
          <button
            ref={closeRef}
            onClick={handleClose}
            aria-label="Close video player"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/20 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C2185B]"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="relative bg-black">
          {error ? (
            <div className="flex aspect-video flex-col items-center justify-center gap-3 text-center">
              <svg className="h-12 w-12 text-white/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm text-white/70">Could not play this video.</p>
              <button
                onClick={handleClose}
                className="rounded-lg bg-white/10 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-white/20"
              >
                Close
              </button>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                src={item.url}
                poster={item.thumbnail_url || undefined}
                controls
                playsInline
                autoPlay
                controlsList="nodownload noremoteplayback"
                className="block aspect-video w-full bg-black object-contain"
                onWaiting={() => setBuffering(true)}
                onPlaying={() => { setBuffering(false); setPlaying(true) }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onCanPlay={() => setBuffering(false)}
                onError={() => { setError(true); setBuffering(false) }}
                onDoubleClick={toggleFullscreen}
              />
              {!playing && (
                <button
                  onClick={play}
                  aria-label="Play video"
                  className="absolute inset-0 flex items-center justify-center bg-black/40 transition group"
                >
                  <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#C2185B] text-white shadow-lg transition group-hover:scale-110 group-hover:bg-[#E91E63] sm:h-20 sm:w-20">
                    <svg className="ml-1 h-7 w-7 sm:h-8 sm:w-8" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </span>
                </button>
              )}
              {buffering && playing && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <svg className="h-10 w-10 animate-spin text-[#C2185B]" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
