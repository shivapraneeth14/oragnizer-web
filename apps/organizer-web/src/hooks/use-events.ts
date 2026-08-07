import { useState, useEffect, useCallback, useRef } from "react"
import { supabase } from "../supabase"
import type { Event } from "shared"

export type EventFormData = {
  title: string
  description: string
  image_url: string
  start_date: string
  end_date: string
  location: string
  latitude: string
  longitude: string
  capacity: string
  price: string
  status: "draft" | "published"
  discussion_enabled: boolean
  discussion_restricted: boolean
}

export interface DescriptionFields {
  about: string
  highlights: string
  schedule: string
  bring: string
  notes: string
}

export function composeDescription(fields: DescriptionFields): string {
  const parts: string[] = []
  if (fields.about.trim()) parts.push(`## About\n${fields.about.trim()}`)
  if (fields.highlights.trim()) parts.push(`## What you'll get\n${fields.highlights.trim()}`)
  if (fields.schedule.trim()) parts.push(`## Schedule\n${fields.schedule.trim()}`)
  if (fields.bring.trim()) parts.push(`## What to bring\n${fields.bring.trim()}`)
  if (fields.notes.trim()) parts.push(`## Additional info\n${fields.notes.trim()}`)
  return parts.join('\n\n')
}

export function parseDescription(description: string): DescriptionFields {
  const fields: DescriptionFields = { about: '', highlights: '', schedule: '', bring: '', notes: '' }
  const sectionMap: Record<string, keyof DescriptionFields> = {
    'about': 'about',
    "what you'll get": 'highlights',
    'schedule': 'schedule',
    'what to bring': 'bring',
    'additional info': 'notes',
  }
  const sections = description.split(/\n(?=## )/)
  for (const section of sections) {
    const match = section.match(/^## (.+?)\n([\s\S]*)$/)
    if (match) {
      const title = match[1].toLowerCase().trim()
      const content = match[2].trim()
      const key = sectionMap[title]
      if (key) fields[key] = content
    }
  }
  return fields
}

export const emptyDescriptionFields: DescriptionFields = {
  about: '', highlights: '', schedule: '', bring: '', notes: '',
}

export const emptyForm: EventFormData = {
  title: "", description: "", image_url: "",
  start_date: "", end_date: "",
  location: "", latitude: "", longitude: "", capacity: "", price: "",
  status: "draft",
  discussion_enabled: false,
  discussion_restricted: false,
}

export function eventToForm(e: Event): EventFormData {
  return {
    title: e.title,
    description: e.description || "",
    image_url: e.image_url || "",
    start_date: toDatetimeLocal(e.start_date),
    end_date: e.end_date ? toDatetimeLocal(e.end_date) : "",
    location: e.location || "",
    latitude: e.latitude?.toString() || "",
    longitude: e.longitude?.toString() || "",
    capacity: e.capacity?.toString() || "",
    price: (e.price / 100).toString(),
    status: e.status === "cancelled" || e.status === "completed" ? "draft" : e.status,
    discussion_enabled: e.discussion_enabled,
    discussion_restricted: e.discussion_restricted,
  }
}

function toDatetimeLocal(dateStr: string): string {
  const d = new Date(dateStr)
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const PAGE_SIZE = 20

export function useEvents(communityId: string | undefined) {
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const pageRef = useRef(0)

  const fetch = useCallback(async (append = false) => {
    if (!communityId) return
    if (append) { setLoadingMore(true) } else { setLoading(true); pageRef.current = 0 }
    const from = pageRef.current * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const { data, error } = await supabase
      .from("events")
      .select("*")
      .eq("community_id", communityId)
      .is("deleted_at", null)
      .order("start_date", { ascending: false })
      .range(from, to)
    if (error) {
      setError(error.message)
    } else {
      const items = data as Event[]
      setEvents(append ? (prev) => [...prev, ...items] : items)
      setHasMore(items.length >= PAGE_SIZE)
      pageRef.current += 1
    }
    setLoading(false)
    setLoadingMore(false)
  }, [communityId])

  useEffect(() => { fetch() }, [fetch])

  const fetchNextPage = useCallback(() => fetch(true), [fetch])

  const createEvent = useCallback(async (data: EventFormData, userId: string) => {
    const startDate = new Date(data.start_date)
    if (!data.start_date || !startDate.getTime()) return "Start date is required"
    if (startDate < new Date()) return "Start date cannot be in the past"
    if (!data.end_date) return "End date is required"
    const endDate = new Date(data.end_date)
    if (!endDate.getTime() || endDate <= startDate) return "End date must be after start date"

    const { error } = await supabase.from("events").insert({
      community_id: communityId,
      title: data.title.trim(),
      description: data.description.trim() || null,
      image_url: data.image_url || null,
      start_date: new Date(data.start_date).toISOString(),
      end_date: data.end_date ? new Date(data.end_date).toISOString() : null,
      location: data.location.trim() || null,
      latitude: data.latitude ? parseFloat(data.latitude) : null,
      longitude: data.longitude ? parseFloat(data.longitude) : null,
      capacity: data.capacity ? parseInt(data.capacity) : null,
      price: Math.round(parseFloat(data.price || "0") * 100),
      status: data.status,
      discussion_enabled: data.discussion_enabled,
      discussion_restricted: data.discussion_restricted,
      created_by: userId,
    })
    if (error) return error.message
    await fetch()
    return null
  }, [communityId, fetch])

  const updateEvent = useCallback(async (id: string, data: EventFormData) => {
    if (!data.start_date || !new Date(data.start_date).getTime()) return "Start date is required"
    if (!data.end_date) return "End date is required"
    const endDate = new Date(data.end_date)
    if (!endDate.getTime() || (data.start_date && endDate <= new Date(data.start_date))) {
      return "End date must be after start date"
    }

    const { error } = await supabase.from("events").update({
      title: data.title.trim(),
      description: data.description.trim() || null,
      image_url: data.image_url || null,
      start_date: new Date(data.start_date).toISOString(),
      end_date: data.end_date ? new Date(data.end_date).toISOString() : null,
      location: data.location.trim() || null,
      latitude: data.latitude ? parseFloat(data.latitude) : null,
      longitude: data.longitude ? parseFloat(data.longitude) : null,
      capacity: data.capacity ? parseInt(data.capacity) : null,
      price: Math.round(parseFloat(data.price || "0") * 100),
      status: data.status,
      discussion_enabled: data.discussion_enabled,
      discussion_restricted: data.discussion_restricted,
    }).eq("id", id)
    if (error) return error.message
    await fetch()
    return null
  }, [fetch])

  const cancelEvent = useCallback(async (id: string): Promise<string | null> => {
    const { data, error } = await supabase.functions.invoke("cancel-event", {
      body: { event_id: id },
    })
    if (error) return error.message
    if (data?.error) return data.error
    await fetch()
    return null
  }, [fetch])

  return { events, loading, loadingMore, hasMore, error, createEvent, updateEvent, cancelEvent, refresh: fetch, fetchNextPage }
}
