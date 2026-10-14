interface NominatimAddress {
  road?: string
  pedestrian?: string
  neighbourhood?: string
  suburb?: string
  hamlet?: string
  village?: string
  town?: string
  city?: string
  county?: string
  state?: string
}

interface NominatimResponse {
  display_name?: string
  address?: NominatimAddress
}

interface NominatimSearchItem extends NominatimResponse {
  lat: string
  lon: string
}

export interface PlaceResult {
  label: string
  lat: number
  lng: number
}

function conciseLabel(data: NominatimResponse): string | null {
  const a = data.address ?? {}
  const primary =
    a.road || a.pedestrian || a.neighbourhood || a.suburb || a.hamlet || a.village || a.town || a.city
  const secondary = a.city || a.town || a.village || a.county || a.state
  const parts = [primary, secondary].filter(
    (p): p is string => !!p && p !== primary,
  )
  return parts.join(", ") || data.display_name || null
}

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as NominatimResponse
    return conciseLabel(data)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function searchPlaces(query: string): Promise<PlaceResult[]> {
  const q = query.trim()
  if (q.length < 3) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=5&addressdetails=1`
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
    if (!res.ok) return []
    const data = (await res.json()) as NominatimSearchItem[]
    return data
      .map((item) => ({
        label: item.display_name || conciseLabel(item) || `${item.lat}, ${item.lon}`,
        lat: Number(item.lat),
        lng: Number(item.lon),
      }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}
