import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

export interface DropdownOption {
  value: string
  label: string
}

interface Props {
  value: string
  onChange: (value: string) => void
  options: DropdownOption[]
  placeholder?: string
  disabled?: boolean
  freeInput?: boolean
  emptyText?: string
}

interface PopupPosition {
  top: number
  left: number
  width: number
}

const inputClasses =
  "w-full rounded-lg border border-neutral-300 px-3.5 py-2 pr-8 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"

export default function DropdownSelect({
  value,
  onChange,
  options,
  placeholder = "Select...",
  disabled = false,
  freeInput = false,
  emptyText = "No matching options",
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(-1)
  const [position, setPosition] = useState<PopupPosition | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selectedLabel = options.find((o) => o.value === value)?.label ?? ""
  const display = freeInput ? value : open ? query : selectedLabel
  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(query.trim().toLowerCase())
  )

  const positionPopup = () => {
    const input = inputRef.current
    if (!input) return
    const rect = input.getBoundingClientRect()
    setPosition({ top: rect.bottom + 4, left: rect.left, width: rect.width })
  }

  useEffect(() => {
    if (!open) return
    positionPopup()
    const reposition = () => positionPopup()
    window.addEventListener("scroll", reposition, true)
    window.addEventListener("resize", reposition)
    return () => {
      window.removeEventListener("scroll", reposition, true)
      window.removeEventListener("resize", reposition)
    }
  }, [open])

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      const inside =
        (rootRef.current && rootRef.current.contains(target)) ||
        (popupRef.current && popupRef.current.contains(target))
      if (!inside) {
        setOpen(false)
        setQuery("")
      }
    }
    document.addEventListener("mousedown", onMouseDown)
    return () => document.removeEventListener("mousedown", onMouseDown)
  }, [])

  useEffect(() => {
    setActive(-1)
  }, [query])

  const pick = (option: DropdownOption) => {
    setOpen(false)
    setQuery("")
    if (option.value !== value) onChange(option.value)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return
    if (e.key === "Escape") {
      setOpen(false)
      setQuery("")
      return
    }
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (active >= 0 && filtered[active]) {
        pick(filtered[active])
      } else if (freeInput) {
        setOpen(false)
        setQuery("")
      }
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        value={display}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => !disabled && setOpen(true)}
        onChange={(e) => {
          if (disabled) return
          setQuery(e.target.value)
          setOpen(true)
          if (freeInput) onChange(e.target.value)
        }}
        onKeyDown={onKeyDown}
        className={`${inputClasses} ${disabled ? "cursor-not-allowed bg-neutral-100 text-neutral-400" : ""}`}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onClick={() => {
          if (disabled) return
          setOpen((o) => !o)
          inputRef.current?.focus()
        }}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 disabled:cursor-not-allowed"
      >
        <svg
          className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && !disabled && position &&
        createPortal(
          <div
            ref={popupRef}
            style={{ top: position.top, left: position.left, width: position.width }}
            className="fixed z-50 max-h-48 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-medium"
          >
            {filtered.length === 0 ? (
              <div className="px-3.5 py-2 text-sm text-neutral-400">{emptyText}</div>
            ) : (
              filtered.map((o, i) => (
                <button
                  key={o.value}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                  onMouseEnter={() => setActive(i)}
                  className={`block w-full px-3.5 py-2 text-left text-sm hover:bg-neutral-50 ${
                    i === active ? "bg-neutral-50" : ""
                  } ${o.value === value ? "bg-[#C2185B]/5 font-medium text-[#C2185B]" : "text-neutral-900"}`}
                >
                  {o.label}
                </button>
              ))
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
