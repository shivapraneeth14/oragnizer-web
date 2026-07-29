import { useState, useEffect, useRef, useCallback } from "react"
import { supabase } from "../../supabase"
import { uploadToCloudinary } from "../../lib/cloudinary"
import { useEvents } from "../../hooks/use-events"

interface MediaItem {
  id: string
  mediable_type: "community" | "event"
  url: string
  thumbnail_url: string | null
  type: "image" | "video"
  sort_order: number
  caption: string | null
}

interface Props {
  communityId: string | undefined
}

export default function MediaSection({ communityId }: Props) {
  const [communityMedia, setCommunityMedia] = useState<MediaItem[]>([])
  const [eventMedia, setEventMedia] = useState<MediaItem[]>([])
  const [selectedEventId, setSelectedEventId] = useState<string>("")
  const [uploading, setUploading] = useState(false)
  const [uploadTarget, setUploadTarget] = useState<"community" | "event">("community")
  const [uploadType, setUploadType] = useState<"image" | "video">("image")
  const [communityMediaLoading, setCommunityMediaLoading] = useState(true)
  const [eventMediaLoading, setEventMediaLoading] = useState(false)
  const [communityMediaError, setCommunityMediaError] = useState<string | null>(null)
  const [eventMediaError, setEventMediaError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { events } = useEvents(communityId)

  const fetchCommunityMedia = useCallback(async () => {
    if (!communityId) return
    setCommunityMediaLoading(true)
    setCommunityMediaError(null)
    const { data, error } = await supabase
      .from("media")
      .select("*")
      .eq("mediable_type", "community")
      .eq("mediable_id", communityId)
      .order("sort_order", { ascending: true })
    if (error) {
      setCommunityMediaError(error.message)
    } else if (data) {
      setCommunityMedia(data as MediaItem[])
    }
    setCommunityMediaLoading(false)
  }, [communityId])

  const fetchEventMedia = useCallback(async (eventId: string) => {
    if (!eventId) { setEventMedia([]); return }
    setEventMediaLoading(true)
    setEventMediaError(null)
    const { data, error } = await supabase
      .from("media")
      .select("*")
      .eq("mediable_type", "event")
      .eq("mediable_id", eventId)
      .order("sort_order", { ascending: true })
    if (error) {
      setEventMediaError(error.message)
    } else if (data) {
      setEventMedia(data as MediaItem[])
    }
    setEventMediaLoading(false)
  }, [])

  useEffect(() => { fetchCommunityMedia() }, [fetchCommunityMedia])
  useEffect(() => { fetchEventMedia(selectedEventId) }, [selectedEventId, fetchEventMedia])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !communityId) return
    setUploading(true)
    try {
      const url = await uploadToCloudinary(file)
      const mediableId = uploadTarget === "community" ? communityId : selectedEventId
      if (!mediableId) return

      const { data: existing } = await supabase
        .from("media")
        .select("sort_order")
        .eq("mediable_type", uploadTarget)
        .eq("mediable_id", mediableId)
        .order("sort_order", { ascending: false })
        .limit(1)

      const nextOrder = existing && existing.length > 0 ? existing[0].sort_order + 1 : 0

      await supabase.from("media").insert({
        mediable_type: uploadTarget,
        mediable_id: mediableId,
        url,
        type: uploadType,
        sort_order: nextOrder,
      })

      if (uploadTarget === "community") {
        await fetchCommunityMedia()
      } else {
        await fetchEventMedia(selectedEventId)
      }
    } catch (err) {
      console.error("Upload failed:", err)
    }
    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const handleDelete = async (item: MediaItem) => {
    const confirmed = window.confirm("Delete this media?")
    if (!confirmed) return
    await supabase.from("media").delete().eq("id", item.id)
    if (item.mediable_type === "community") {
      await fetchCommunityMedia()
    } else {
      await fetchEventMedia(selectedEventId)
    }
  }

  const triggerUpload = (target: "community" | "event", type: "image" | "video") => {
    if (target === "event" && !selectedEventId) return
    setUploadTarget(target)
    setUploadType(type)
    fileInputRef.current?.click()
  }

  return (
    <div>
      <h3 className="text-xl font-semibold text-neutral-900">Media Gallery</h3>
      <p className="mt-2 text-sm text-neutral-500">Manage photos and videos for your community and events.</p>

      <input
        ref={fileInputRef}
        type="file"
        accept={uploadType === "image" ? "image/*" : "video/*"}
        onChange={handleUpload}
        className="hidden"
      />

      {/* Community Media */}
      <div className="mt-8">
        <div className="flex items-center justify-between">
          <h4 className="text-lg font-semibold text-neutral-800">Community Photos & Videos</h4>
          <div className="flex gap-2">
            <button
              onClick={() => triggerUpload("community", "image")}
              disabled={uploading}
              className="flex items-center gap-1 rounded-lg bg-[#C2185B] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50"
            >
              + Photo
            </button>
            <button
              onClick={() => triggerUpload("community", "video")}
              disabled={uploading}
              className="flex items-center gap-1 rounded-lg border border-[#C2185B] px-3 py-1.5 text-sm font-medium text-[#C2185B] hover:bg-[#C2185B]/5 disabled:opacity-50"
            >
              + Video
            </button>
          </div>
        </div>
        {communityMediaLoading ? (
          <div className="mt-4 flex justify-center py-12">
            <svg className="h-6 w-6 animate-spin text-[#C2185B]" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : communityMediaError ? (
          <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{communityMediaError}</div>
        ) : (
          <>
        {uploading && uploadTarget === "community" && (
          <p className="mt-2 text-sm text-neutral-500">Uploading...</p>
        )}
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {communityMedia.map((item) => (
            <MediaCard key={item.id} item={item} onDelete={handleDelete} />
          ))}
          {communityMedia.length === 0 && !uploading && (
            <p className="col-span-full py-8 text-center text-sm text-neutral-400">No media yet. Add photos and videos for your community.</p>
          )}
        </div>
        </>
        )}
      </div>

      {/* Event Media */}
      <div className="mt-12">
        <h4 className="text-lg font-semibold text-neutral-800">Event Media</h4>
        <p className="mt-1 text-sm text-neutral-500">Select an event to manage its photos and videos.</p>
        <select
          value={selectedEventId}
          onChange={(e) => setSelectedEventId(e.target.value)}
          className="mt-3 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-[#C2185B] focus:outline-none focus:ring-1 focus:ring-[#C2185B] max-w-xs"
        >
          <option value="">Select an event...</option>
          {events.map((ev) => (
            <option key={ev.id} value={ev.id}>
              {ev.title}
            </option>
          ))}
        </select>
        {selectedEventId && (
          <div className="mt-4">
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => triggerUpload("event", "image")}
                disabled={uploading}
                className="flex items-center gap-1 rounded-lg bg-[#C2185B] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50"
              >
                + Photo
              </button>
              <button
                onClick={() => triggerUpload("event", "video")}
                disabled={uploading}
                className="flex items-center gap-1 rounded-lg border border-[#C2185B] px-3 py-1.5 text-sm font-medium text-[#C2185B] hover:bg-[#C2185B]/5 disabled:opacity-50"
              >
                + Video
              </button>
            </div>
            {uploading && uploadTarget === "event" && (
              <p className="mb-2 text-sm text-neutral-500">Uploading...</p>
            )}
            {eventMediaLoading ? (
              <div className="flex justify-center py-12">
                <svg className="h-6 w-6 animate-spin text-[#C2185B]" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              </div>
            ) : eventMediaError ? (
              <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{eventMediaError}</div>
            ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {eventMedia.map((item) => (
                <MediaCard key={item.id} item={item} onDelete={handleDelete} />
              ))}
              {eventMedia.length === 0 && !uploading && (
                <p className="col-span-full py-8 text-center text-sm text-neutral-400">No media for this event yet.</p>
              )}
            </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function MediaCard({ item, onDelete }: { item: MediaItem; onDelete: (item: MediaItem) => void }) {
  const isVideo = item.type === "video"
  const [imgError, setImgError] = useState(false)

  return (
    <div className="group relative rounded-xl border border-neutral-200 bg-white overflow-hidden shadow-soft">
      <div className="aspect-[4/3] overflow-hidden">
        {isVideo ? (
          <div className="relative flex h-full items-center justify-center bg-neutral-900">
            {item.thumbnail_url && !imgError ? (
              <img
                src={item.thumbnail_url}
                alt=""
                className="h-full w-full object-cover"
                onError={() => setImgError(true)}
              />
            ) : (
              <svg className="h-10 w-10 text-white/60" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
            <div className="absolute inset-0 flex items-center justify-center">
              <svg className="h-10 w-10 text-white/80" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        ) : (
          <img
            src={item.url}
            alt={item.caption || ""}
            className="h-full w-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none" }}
          />
        )}
      </div>
      <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={() => onDelete(item)}
          className="flex h-7 w-7 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600 shadow"
          title="Delete"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="px-2.5 py-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500">
          {isVideo ? "Video" : "Photo"}
        </span>
      </div>
    </div>
  )
}
