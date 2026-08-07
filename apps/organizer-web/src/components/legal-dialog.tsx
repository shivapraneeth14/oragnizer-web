import { useEffect } from "react"
import type { ReactNode } from "react"
import type { LegalSection } from "../legal/privacy-content"

interface LegalDialogProps {
  title: string
  sections: LegalSection[]
  onClose: () => void
}

function LegalDialog({ title, sections, onClose }: LegalDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-strong"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-neutral-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-2 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5 text-[14px] leading-6 text-neutral-700">
          {sections.map((s) => (
            <section key={s.heading}>
              <h3 className="font-semibold text-neutral-900">{s.heading}</h3>
              <div className="mt-1.5 space-y-2">{s.body}</div>
            </section>
          ))}
        </div>
        <div className="border-t border-neutral-200 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg bg-[#C2185B] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#A0154A]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export default function LegalDialogHost({
  open,
  title,
  sections,
  onClose,
}: LegalDialogProps & { open: boolean }): ReactNode {
  if (!open) return null
  return <LegalDialog title={title} sections={sections} onClose={onClose} />
}
