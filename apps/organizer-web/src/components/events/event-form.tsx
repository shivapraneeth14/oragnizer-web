import { useState, useRef, useEffect } from "react"
import { uploadToCloudinary } from "../../lib/cloudinary"
import type { EventFormData } from "../../hooks/use-events"
import { emptyForm } from "../../hooks/use-events"

interface Props {
  initial?: EventFormData
  saving: boolean
  onSave: (data: EventFormData) => Promise<void>
  onClose: () => void
}

export default function EventForm({ initial, saving, onSave, onClose }: Props) {
  const [form, setForm] = useState<EventFormData>(initial || emptyForm)
  const [uploading, setUploading] = useState(false)
  const [errors, setErrors] = useState<{ start?: string; end?: string }>({})
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (initial) setForm(initial)
  }, [initial])

  const update = <K extends keyof EventFormData>(key: K, value: EventFormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const url = await uploadToCloudinary(file)
      update("image_url", url)
    } catch {
      // upload failed
    } finally {
      setUploading(false)
      e.target.value = ""
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.title.trim()) return

    const errs: typeof errors = {}
    if (!form.start_date) {
      errs.start = "Start date is required"
    } else if (!isEditing) {
      const now = new Date()
      const start = new Date(form.start_date)
      const minTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes())
      if (start < minTime) {
        errs.start = "Start date cannot be in the past"
      }
    }
    if (form.end_date && form.start_date && new Date(form.end_date) <= new Date(form.start_date)) {
      errs.end = "End date must be after start date"
    }

    setErrors(errs)
    if (Object.keys(errs).length) return
    await onSave(form)
  }

  const isEditing = !!initial

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
          <h3 className="text-lg font-semibold text-neutral-900">
            {isEditing ? "Edit Event" : "Create Event"}
          </h3>
          <button onClick={onClose} className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          {/* Image */}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">Event Image</label>
            <input ref={inputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
            <div className="flex items-center gap-3">
              <div className="flex h-20 w-32 items-center justify-center overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50">
                {form.image_url ? (
                  <img src={form.image_url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-xs text-neutral-400">No image</span>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading}
                  className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
                >
                  {uploading ? "Uploading..." : form.image_url ? "Change" : "Upload"}
                </button>
                {form.image_url && (
                  <button type="button" onClick={() => update("image_url", "")}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">Title *</label>
            <input value={form.title} onChange={(e) => update("title", e.target.value)}
              placeholder="Event title"
              className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">Description</label>
            <textarea value={form.description} onChange={(e) => update("description", e.target.value)}
              placeholder="Describe your event..." rows={3}
              className="w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
            />
          </div>

          {/* Start / End Date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">Start *</label>
              <input type="datetime-local" value={form.start_date}
                onChange={(e) => { setErrors((p) => ({ ...p, start: undefined })); update("start_date", e.target.value) }}
                min={isEditing ? undefined : new Date().toISOString().slice(0, 16)}
                className={`w-full rounded-lg border px-3.5 py-2 text-sm outline-none transition focus:ring-1 focus:ring-[#C2185B]/20 ${
                  errors.start ? "border-red-400 focus:border-red-500" : "border-neutral-300 focus:border-[#C2185B]"
                }`}
              />
              {errors.start && <p className="mt-1 text-xs text-red-500">{errors.start}</p>}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">End</label>
              <input type="datetime-local" value={form.end_date}
                onChange={(e) => { setErrors((p) => ({ ...p, end: undefined })); update("end_date", e.target.value) }}
                className={`w-full rounded-lg border px-3.5 py-2 text-sm outline-none transition focus:ring-1 focus:ring-[#C2185B]/20 ${
                  errors.end ? "border-red-400 focus:border-red-500" : "border-neutral-300 focus:border-[#C2185B]"
                }`}
              />
              {errors.end && <p className="mt-1 text-xs text-red-500">{errors.end}</p>}
            </div>
          </div>

          {/* Location */}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">Location</label>
            <input value={form.location} onChange={(e) => update("location", e.target.value)}
              placeholder="Event location"
              className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
            />
          </div>

          {/* Capacity / Price */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">Capacity</label>
              <input type="number" min="0" value={form.capacity}
                onChange={(e) => update("capacity", e.target.value)}
                placeholder="Max attendees"
                className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">Price (₹)</label>
              <input type="number" min="0" step="0.01" value={form.price}
                onChange={(e) => update("price", e.target.value)}
                placeholder="0 = Free"
                className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
              />
            </div>
          </div>

          {/* Status */}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">Status</label>
            <div className="flex gap-2">
              {(["draft", "published"] as const).map((s) => (
                <button key={s} type="button" onClick={() => update("status", s)}
                  className={`rounded-lg px-4 py-1.5 text-xs font-medium transition ${
                    form.status === s ? "bg-[#C2185B] text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                  }`}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
            >
              Cancel
            </button>
            <button type="submit" disabled={saving || !form.title.trim()}
              className="rounded-lg bg-[#C2185B] px-4 py-2 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50"
            >
              {saving ? "Saving..." : isEditing ? "Save changes" : "Create event"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
