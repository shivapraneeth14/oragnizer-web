import { useState, useRef, useEffect } from "react"
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from "react-leaflet"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import type { LatLngLiteral } from "leaflet"
import { uploadToCloudinary } from "../../lib/cloudinary"
import { reverseGeocode, searchPlaces } from "../../lib/geocode"
import type { PlaceResult } from "../../lib/geocode"
import type { EventFormData, DescriptionFields } from "../../hooks/use-events"
import { emptyForm, composeDescription, parseDescription, emptyDescriptionFields } from "../../hooks/use-events"

interface Props {
  initial?: EventFormData
  saving: boolean
  onSave: (data: EventFormData) => Promise<void>
  onClose: () => void
}

const DEFAULT_CENTER: LatLngLiteral = { lat: 17.385, lng: 78.4867 }

const pinIcon = L.divIcon({
  className: "",
  html: `<svg width="32" height="32" viewBox="0 0 24 24" fill="#C2185B" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>`,
  iconSize: [32, 32],
  iconAnchor: [16, 32],
})

function MapClickHandler({ onPick }: { onPick: (p: LatLngLiteral) => void }) {
  useMapEvents({
    click(e) {
      onPick({ lat: e.latlng.lat, lng: e.latlng.lng })
    },
  })
  return null
}

interface FlyTarget {
  lat: number
  lng: number
  id: number
}

function MapFlyTo({ target }: { target: FlyTarget | null }) {
  const map = useMap()
  useEffect(() => {
    if (!target) return
    map.flyTo([target.lat, target.lng], 16)
  }, [map, target])
  return null
}

function parseCoord(value: string): number | null {
  if (!value.trim()) return null
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : null
}

export default function EventForm({ initial, saving, onSave, onClose }: Props) {
  const [form, setForm] = useState<EventFormData>(initial || emptyForm)
  const [uploading, setUploading] = useState(false)
  const [locating, setLocating] = useState(false)
  const [errors, setErrors] = useState<{ start?: string; end?: string; location?: string }>({})
  const [descFields, setDescFields] = useState<DescriptionFields>(() =>
    initial?.description ? parseDescription(initial.description) : emptyDescriptionFields
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)
  const [placeQuery, setPlaceQuery] = useState("")
  const [placeResults, setPlaceResults] = useState<PlaceResult[]>([])
  const [placeSearching, setPlaceSearching] = useState(false)
  const [placeOpen, setPlaceOpen] = useState(false)
  const [flyTarget, setFlyTarget] = useState<FlyTarget | null>(null)
  const searchSeq = useRef(0)

  const initialCenter: LatLngLiteral = (() => {
    const lat = initial ? parseCoord(initial.latitude) : null
    const lng = initial ? parseCoord(initial.longitude) : null
    return lat != null && lng != null ? { lat, lng } : DEFAULT_CENTER
  })()

  useEffect(() => {
    if (initial) {
      setForm(initial)
      setDescFields(initial.description ? parseDescription(initial.description) : emptyDescriptionFields)
    }
  }, [initial])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    const q = placeQuery.trim()
    if (q.length < 3) {
      setPlaceResults([])
      setPlaceSearching(false)
      return
    }
    setPlaceSearching(true)
    const timer = setTimeout(async () => {
      const seq = ++searchSeq.current
      const results = await searchPlaces(q)
      if (!mountedRef.current || seq !== searchSeq.current) return
      setPlaceResults(results)
      setPlaceSearching(false)
      setPlaceOpen(true)
    }, 450)
    return () => clearTimeout(timer)
  }, [placeQuery])

  const update = <K extends keyof EventFormData>(key: K, value: EventFormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handlePick = async (p: LatLngLiteral) => {
    const lat = p.lat.toFixed(6)
    const lng = p.lng.toFixed(6)
    const coordLabel = `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`
    setErrors((prev) => ({ ...prev, location: undefined }))
    update("latitude", lat)
    update("longitude", lng)
    update("location", coordLabel)
    setLocating(true)
    const address = await reverseGeocode(p.lat, p.lng)
    if (!mountedRef.current) return
    if (address) update("location", address)
    setLocating(false)
  }

  const clearPin = () => {
    update("latitude", "")
    update("longitude", "")
    update("location", "")
    setPlaceQuery("")
    setPlaceResults([])
    setPlaceOpen(false)
  }

  const selectPlace = (p: PlaceResult) => {
    setPlaceQuery("")
    setPlaceResults([])
    setPlaceOpen(false)
    setFlyTarget({ lat: p.lat, lng: p.lng, id: Date.now() })
    void handlePick({ lat: p.lat, lng: p.lng })
  }

  const updateDesc = (key: keyof DescriptionFields, value: string) => {
    setDescFields((prev) => ({ ...prev, [key]: value }))
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
    if (!form.latitude || !form.longitude) {
      errs.location = "Drop a pin on the map for the event location"
    }
    if (!form.start_date) {
      errs.start = "Start date is required"
    } else {
      const now = new Date()
      const start = new Date(form.start_date)
      const minTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes())
      const changed = !initial || form.start_date !== initial.start_date
      if (changed && start < minTime) {
        errs.start = "Start date cannot be in the past"
      }
    }
    if (!form.end_date) {
      errs.end = "End date is required"
    } else if (form.start_date && new Date(form.end_date) <= new Date(form.start_date)) {
      errs.end = "End date must be after start date"
    }

    setErrors(errs)
    if (Object.keys(errs).length) return
    await onSave({ ...form, description: composeDescription(descFields) })
  }

  const isEditing = !!initial

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-4 sm:px-6">
          <h3 className="text-lg font-semibold text-neutral-900">
            {isEditing ? "Edit Event" : "Create Event"}
          </h3>
          <button onClick={onClose} className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-4 py-5 sm:px-6">
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
              className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-cluvo-primary focus:ring-1 focus:ring-cluvo-primary/20"
            />
          </div>

          {/* Description */}
          <div className="space-y-3">
            <label className="mb-1 block text-xs font-medium text-neutral-500">Description</label>

            <div>
              <label className="mb-1 block text-xs text-neutral-400">About this event</label>
              <textarea value={descFields.about} onChange={(e) => updateDesc("about", e.target.value)}
                placeholder="What is this event about?" rows={2}
                className="w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-cluvo-primary focus:ring-1 focus:ring-cluvo-primary/20"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-neutral-400">What you'll get</label>
              <textarea value={descFields.highlights} onChange={(e) => updateDesc("highlights", e.target.value)}
                placeholder="Key takeaways, benefits, what attendees will gain…" rows={2}
                className="w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-cluvo-primary focus:ring-1 focus:ring-cluvo-primary/20"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-neutral-400">Schedule / Agenda</label>
              <textarea value={descFields.schedule} onChange={(e) => updateDesc("schedule", e.target.value)}
                placeholder="Timeline, session times, breaks…" rows={2}
                className="w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-cluvo-primary focus:ring-1 focus:ring-cluvo-primary/20"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-neutral-400">What to bring <span className="text-neutral-300">(optional)</span></label>
              <textarea value={descFields.bring} onChange={(e) => updateDesc("bring", e.target.value)}
                placeholder="Items attendees should bring…" rows={1}
                className="w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-cluvo-primary focus:ring-1 focus:ring-cluvo-primary/20"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-neutral-400">Additional info <span className="text-neutral-300">(optional)</span></label>
              <textarea value={descFields.notes} onChange={(e) => updateDesc("notes", e.target.value)}
                placeholder="Parking, dress code, refund policy, etc…" rows={1}
                className="w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-cluvo-primary focus:ring-1 focus:ring-cluvo-primary/20"
              />
            </div>
          </div>

          {/* Start / End Date */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">Start *</label>
              <input type="datetime-local" value={form.start_date}
                onChange={(e) => { setErrors((p) => ({ ...p, start: undefined })); update("start_date", e.target.value) }}
                min={new Date().toISOString().slice(0, 16)}
                className={`w-full rounded-lg border px-3.5 py-2 text-sm outline-none transition focus:ring-1 focus:ring-cluvo-primary/20 ${
                  errors.start ? "border-red-400 focus:border-red-500" : "border-neutral-300 focus:border-cluvo-primary"
                }`}
              />
              {errors.start && <p className="mt-1 text-xs text-red-500">{errors.start}</p>}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">End *</label>
              <input type="datetime-local" value={form.end_date}
                onChange={(e) => { setErrors((p) => ({ ...p, end: undefined })); update("end_date", e.target.value) }}
                className={`w-full rounded-lg border px-3.5 py-2 text-sm outline-none transition focus:ring-1 focus:ring-cluvo-primary/20 ${
                  errors.end ? "border-red-400 focus:border-red-500" : "border-neutral-300 focus:border-cluvo-primary"
                }`}
              />
              {errors.end && <p className="mt-1 text-xs text-red-500">{errors.end}</p>}
            </div>
          </div>

          {/* Location pin */}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">
              Location <span className="text-neutral-400">*</span>
            </label>
            <div className="relative z-20 mb-2">
              <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400"
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="text"
                value={placeQuery}
                onChange={(e) => { setPlaceQuery(e.target.value); setPlaceOpen(true) }}
                onFocus={() => { if (placeResults.length) setPlaceOpen(true) }}
                onBlur={() => setTimeout(() => { if (mountedRef.current) setPlaceOpen(false) }, 150)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && placeResults.length) { e.preventDefault(); selectPlace(placeResults[0]) }
                  if (e.key === "Escape") setPlaceOpen(false)
                }}
                placeholder="Search a place or address…"
                className="w-full rounded-lg border border-neutral-300 py-2 pl-9 pr-3 text-sm outline-none transition focus:border-cluvo-primary focus:ring-1 focus:ring-cluvo-primary/20"
              />
              {placeOpen && (placeSearching || placeQuery.trim().length >= 3) && (
                <div className="absolute z-[1100] mt-1 w-full overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg">
                  {placeSearching ? (
                    <p className="px-3 py-2 text-xs text-neutral-400">Searching…</p>
                  ) : placeResults.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-neutral-400">No matches found.</p>
                  ) : (
                    placeResults.map((p, i) => (
                      <button key={`${p.lat}-${p.lng}-${i}`} type="button" onClick={() => selectPlace(p)}
                        className="block w-full truncate px-3 py-2 text-left text-xs text-neutral-700 hover:bg-neutral-50"
                      >
                        {p.label}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <div className="relative z-0 h-56 overflow-hidden rounded-lg border border-neutral-200">
              <MapContainer
                center={initialCenter}
                zoom={initial ? 15 : 12}
                scrollWheelZoom
                style={{ height: "100%", width: "100%" }}
              >
                <TileLayer
                  url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  maxZoom={19}
                />
                <MapClickHandler onPick={handlePick} />
                <MapFlyTo target={flyTarget} />
                {form.latitude && form.longitude && (
                  <Marker position={{ lat: parseCoord(form.latitude)!, lng: parseCoord(form.longitude)! }} icon={pinIcon} />
                )}
              </MapContainer>
            </div>
            {form.latitude && form.longitude ? (
              <div className="mt-2 flex items-center justify-between">
                <span className="text-xs text-neutral-500">
                  {Number(form.latitude).toFixed(5)}, {Number(form.longitude).toFixed(5)}
                </span>
                <button type="button" onClick={clearPin}
                  className="rounded-lg px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50"
                >
                  Remove pin
                </button>
              </div>
            ) : (
              <p className="mt-2 text-xs text-neutral-400">Click on the map to drop a pin.</p>
            )}
          </div>

          {/* Location (auto-filled from the pin, read-only) */}
          <div>
            <input value={form.location} readOnly tabIndex={-1} aria-label="Selected location"
              placeholder="Drop a pin on the map to set the location"
              className={`w-full cursor-not-allowed rounded-lg border px-3.5 py-2 text-sm outline-none ${
                errors.location
                  ? "border-red-400 bg-red-50/40 text-neutral-700"
                  : "border-neutral-200 bg-neutral-100 text-neutral-600"
              }`}
            />
            {errors.location ? (
              <p className="mt-1 text-xs text-red-500">{errors.location}</p>
            ) : (
              <p className="mt-1 text-xs text-neutral-400">
                {locating ? "Looking up the address…" : "Auto-filled from the map pin — move the pin to change it."}
              </p>
            )}
          </div>

          {/* Capacity / Price */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">Capacity</label>
              <input type="number" min="0" value={form.capacity}
                onChange={(e) => update("capacity", e.target.value)}
                placeholder="Max attendees"
                className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-cluvo-primary focus:ring-1 focus:ring-cluvo-primary/20"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">Price (₹)</label>
              <input type="number" min="0" step="0.01" value={form.price}
                onChange={(e) => update("price", e.target.value)}
                placeholder="0 = Free"
                className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-cluvo-primary focus:ring-1 focus:ring-cluvo-primary/20"
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
                    form.status === s ? "bg-cluvo-primary text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                  }`}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Discussion */}
          <div>
            <label className="mb-2 block text-xs font-medium text-neutral-500">Discussion</label>
            <div className="space-y-2 rounded-lg border border-neutral-200 bg-white p-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.discussion_enabled}
                  onChange={(e) => update("discussion_enabled", e.target.checked)}
                  className="h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-neutral-700">Enable Discussion</span>
              </label>
              {form.discussion_enabled && (
                <label className="flex items-center gap-3 cursor-pointer ml-6">
                  <input
                    type="checkbox"
                    checked={form.discussion_restricted}
                    onChange={(e) => update("discussion_restricted", e.target.checked)}
                    className="h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-neutral-700">Restrict to admins only</span>
                </label>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={onClose}
              className="w-full rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50 sm:w-auto"
            >
              Cancel
            </button>
            <button type="submit" disabled={saving || locating || !form.title.trim()}
              className="w-full rounded-lg bg-cluvo-primary px-4 py-2 text-sm font-medium text-white hover:bg-cluvo-primary-dark disabled:opacity-50 sm:w-auto"
            >
              {saving ? "Saving..." : locating ? "Locating..." : isEditing ? "Save changes" : "Create event"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
