import { optionalEnv, requiredEnv } from "../_shared/env.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts"
import { cloudinaryPublicId } from "../_shared/deletion.ts"
import { logError } from "../_shared/logger.ts"
import { getCorsHeaders } from "../_shared/cors.ts"

const supabaseUrl = requiredEnv("SUPABASE_URL")
const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabase = createClient(supabaseUrl, supabaseServiceKey)

export async function cloudinaryDestroy(publicId: string): Promise<boolean> {
  const apiKey = optionalEnv("CLOUDINARY_API_KEY")
  const apiSecret = optionalEnv("CLOUDINARY_API_SECRET")
  const cloud = optionalEnv("CLOUDINARY_CLOUD_NAME")
  if (!apiKey || !apiSecret || !cloud) {
    // Cloudinary API secrets not configured on this environment; return true (idempotent no-op)
    return true
  }

  const ts = Math.floor(Date.now() / 1000).toString()
  const signatureInput = `public_id=${publicId}&timestamp=${ts}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(apiSecret),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
  )
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(signatureInput))
  const signature = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0")).join("")

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloud}/image/destroy`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        public_id: publicId,
        timestamp: ts,
        api_key: apiKey,
        signature,
      }),
    },
  )
  return res.ok
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })

    const rl = await checkRateLimit(user.id, "delete-media")
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter)

    const { asset_url, public_id } = await req.json()
    const targetUrl = typeof asset_url === "string" ? asset_url.trim() : null
    const rawPublicId = typeof public_id === "string" ? public_id.trim() : null

    const targetPublicId = rawPublicId || cloudinaryPublicId(targetUrl)
    if (!targetPublicId || !/^[a-zA-Z0-9_\-\/]+$/.test(targetPublicId)) {
      return new Response(JSON.stringify({ error: "Valid asset_url or public_id is required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    // 1. Anti-Destruction Guard:
    // Strictly forbid deleting any active profile avatar across the platform
    const { data: activeProfile } = await supabase
      .from("profiles")
      .select("id")
      .ilike("avatar_url", `%${targetPublicId}%`)
      .limit(1)
      .maybeSingle()

    if (activeProfile) {
      return new Response(
        JSON.stringify({ error: "Cannot destroy active profile avatar" }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
      )
    }

    // Strictly forbid deleting active community banners or avatars
    const { data: activeComm } = await supabase
      .from("communities")
      .select("id")
      .or(`banner_url.ilike.%${targetPublicId}%,community_avatar_url.ilike.%${targetPublicId}%`)
      .limit(1)
      .maybeSingle()

    if (activeComm) {
      return new Response(
        JSON.stringify({ error: "Cannot destroy active community asset" }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
      )
    }

    // Strictly forbid deleting active event poster images or promotional videos
    const { data: activeEvent } = await supabase
      .from("events")
      .select("id")
      .or(`image_url.ilike.%${targetPublicId}%,video_url.ilike.%${targetPublicId}%`)
      .limit(1)
      .maybeSingle()

    if (activeEvent) {
      return new Response(
        JSON.stringify({ error: "Cannot destroy active event asset" }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
      )
    }

    // Strictly forbid deleting active gallery media (images, videos, thumbnails)
    const { data: activeMedia } = await supabase
      .from("media")
      .select("id")
      .or(`url.ilike.%${targetPublicId}%,thumbnail_url.ilike.%${targetPublicId}%`)
      .limit(1)
      .maybeSingle()

    if (activeMedia) {
      return new Response(
        JSON.stringify({ error: "Cannot destroy active gallery media asset" }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
      )
    }

    // 2. Perform signed Cloudinary destruction
    const destroyed = await cloudinaryDestroy(targetPublicId)
    if (!destroyed) {
      logError("delete-media: cloudinaryDestroy failed", { targetPublicId, userId: user.id })
      return new Response(
        JSON.stringify({ error: "Failed to delete asset from Cloudinary", public_id: targetPublicId }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
      )
    }

    return new Response(
      JSON.stringify({ success: true, public_id: targetPublicId }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    )
  } catch (err) {
    logError("delete-media error", err)
    return new Response(
      JSON.stringify({ error: "Something went wrong" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    )
  }
})

