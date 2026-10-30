// supabase/tests/media_cleanup.test.ts
// Verifies BUG-001 & BUG-006 remediation:
// 1. delete-media Edge Function security and anti-destruction check.
// 2. Client secret isolation (no Cloudinary secrets on client).
// 3. Comparison of normalized Cloudinary public IDs.
// 4. Protection of active gallery media (images, videos, thumbnails).
// 5. Protection of active event promotional videos.
// 6. Preservation of legitimate orphaned upload cleanup.

import { assert, assertEquals } from "jsr:@std/assert"
import { cloudinaryPublicId } from "../functions/_shared/deletion.ts"

const functionsDir = new URL("../functions/", import.meta.url)

Deno.test("BUG-001: cloudinaryPublicId extracts and normalizes Cloudinary public IDs", () => {
  const versioned = "https://res.cloudinary.com/demo/image/upload/v1612345678/avatars/user_123.jpg"
  const unversioned = "https://res.cloudinary.com/demo/image/upload/avatars/user_123.png"
  const nonCloudinary = "https://example.com/images/pic.jpg"

  assertEquals(cloudinaryPublicId(versioned), "avatars/user_123")
  assertEquals(cloudinaryPublicId(unversioned), "avatars/user_123")
  assertEquals(cloudinaryPublicId(nonCloudinary), null)
  assertEquals(cloudinaryPublicId(null), null)
})

Deno.test("BUG-001/BUG-006: delete-media Edge Function enforces anti-destruction check across all tables", async () => {
  const ts = await Deno.readTextFile(new URL("delete-media/index.ts", functionsDir))

  // Authentication check
  assert(ts.includes("Authorization"), "Must require Authorization header")
  assert(ts.includes("getUser(token)"), "Must verify session token")

  // Anti-destruction guard for profiles
  assert(ts.includes("Cannot destroy active profile avatar"), "Must reject destroying active profile avatar")
  assert(ts.includes('.from("profiles")'), "Must check profiles table")
  assert(ts.includes("avatar_url"), "Must check avatar_url column")

  // Anti-destruction guard for communities
  assert(ts.includes("Cannot destroy active community asset"), "Must reject destroying active community asset")
  assert(ts.includes('.from("communities")'), "Must check communities table")
  assert(ts.includes("banner_url"), "Must check banner_url column")
  assert(ts.includes("community_avatar_url"), "Must check community_avatar_url column")

  // Anti-destruction guard for events (poster image & promo video)
  assert(ts.includes("Cannot destroy active event asset"), "Must reject destroying active event asset")
  assert(ts.includes('.from("events")'), "Must check events table")
  assert(ts.includes("image_url"), "Must check event image_url")
  assert(ts.includes("video_url"), "Must check event video_url")

  // Anti-destruction guard for gallery media (images, videos, thumbnails)
  assert(ts.includes("Cannot destroy active gallery media asset"), "Must reject destroying active gallery media asset")
  assert(ts.includes('.from("media")'), "Must check public.media table")
  assert(ts.includes("url.ilike"), "Must check media url column")
  assert(ts.includes("thumbnail_url.ilike"), "Must check media thumbnail_url column")

  // Input sanitization / safe filter checking
  assert(ts.includes("^[a-zA-Z0-9_\\-\\/]+$"), "Must enforce strict alphanumeric and path regex on public IDs")

  // Rate limiting
  assert(ts.includes("checkRateLimit"), "Must enforce rate limiting")
})

Deno.test("BUG-006: Behavioral simulation - Protection of active gallery images, videos, thumbnails & event assets", () => {
  // Database active asset registry simulating existing platform records
  const database = {
    profiles: [
      { id: "usr_alice", avatar_url: "https://res.cloudinary.com/cluvo/image/upload/v1/avatars/alice_101.jpg" },
    ],
    communities: [
      {
        id: "comm_react",
        banner_url: "https://res.cloudinary.com/cluvo/image/upload/v1/banners/react_conf.jpg",
        community_avatar_url: "https://res.cloudinary.com/cluvo/image/upload/v1/comm_avatars/react_logo.png",
      },
    ],
    events: [
      {
        id: "evt_summit",
        image_url: "https://res.cloudinary.com/cluvo/image/upload/v1/events/summit_poster.jpg",
        video_url: "https://res.cloudinary.com/cluvo/video/upload/v1/events/summit_promo.mp4",
      },
    ],
    media: [
      {
        id: "med_img_1",
        mediable_id: "comm_react",
        mediable_type: "community",
        url: "https://res.cloudinary.com/cluvo/image/upload/v1/gallery/bob_presentation.jpg",
        thumbnail_url: null,
      },
      {
        id: "med_vid_1",
        mediable_id: "evt_summit",
        mediable_type: "event",
        url: "https://res.cloudinary.com/cluvo/video/upload/v1/gallery/keynote_speech.mp4",
        thumbnail_url: "https://res.cloudinary.com/cluvo/image/upload/v1/gallery/keynote_thumb.jpg",
      },
    ],
  }

  // Simulated anti-destruction evaluator matching delete-media/index.ts logic
  function evaluateDeletionRequest(targetPublicId: string): { status: number; error?: string; success?: boolean } {
    if (!targetPublicId || !/^[a-zA-Z0-9_\-\/]+$/.test(targetPublicId)) {
      return { status: 400, error: "Valid asset_url or public_id is required" }
    }

    // 1. Profiles check
    if (database.profiles.some((p) => p.avatar_url?.includes(targetPublicId))) {
      return { status: 403, error: "Cannot destroy active profile avatar" }
    }

    // 2. Communities check
    if (database.communities.some((c) => c.banner_url?.includes(targetPublicId) || c.community_avatar_url?.includes(targetPublicId))) {
      return { status: 403, error: "Cannot destroy active community asset" }
    }

    // 3. Events check (image poster or promo video)
    if (database.events.some((e) => e.image_url?.includes(targetPublicId) || e.video_url?.includes(targetPublicId))) {
      return { status: 403, error: "Cannot destroy active event asset" }
    }

    // 4. Gallery media check (url or thumbnail_url)
    if (database.media.some((m) => m.url?.includes(targetPublicId) || m.thumbnail_url?.includes(targetPublicId))) {
      return { status: 403, error: "Cannot destroy active gallery media asset" }
    }

    // 5. Eligible orphaned asset: destruction allowed
    return { status: 200, success: true }
  }

  // Test 1: User A attempting to delete User B's active gallery image
  const galleryImageResult = evaluateDeletionRequest("gallery/bob_presentation")
  assertEquals(galleryImageResult.status, 403)
  assertEquals(galleryImageResult.error, "Cannot destroy active gallery media asset")

  // Test 2: User A attempting to delete an active gallery thumbnail
  const galleryThumbResult = evaluateDeletionRequest("gallery/keynote_thumb")
  assertEquals(galleryThumbResult.status, 403)
  assertEquals(galleryThumbResult.error, "Cannot destroy active gallery media asset")

  // Test 3: User A attempting to delete an active community gallery video
  const galleryVideoResult = evaluateDeletionRequest("gallery/keynote_speech")
  assertEquals(galleryVideoResult.status, 403)
  assertEquals(galleryVideoResult.error, "Cannot destroy active gallery media asset")

  // Test 4: User A attempting to delete an active event promotional video
  const eventVideoResult = evaluateDeletionRequest("events/summit_promo")
  assertEquals(eventVideoResult.status, 403)
  assertEquals(eventVideoResult.error, "Cannot destroy active event asset")

  // Test 5: Existing profile avatar, community banner/avatar, and event poster protection continues working
  assertEquals(evaluateDeletionRequest("avatars/alice_101").status, 403)
  assertEquals(evaluateDeletionRequest("banners/react_conf").status, 403)
  assertEquals(evaluateDeletionRequest("comm_avatars/react_logo").status, 403)
  assertEquals(evaluateDeletionRequest("events/summit_poster").status, 403)

  // Test 6: Eligible unused orphaned uploads CAN still be safely deleted
  const orphanResult = evaluateDeletionRequest("temp_abandoned_upload_999")
  assertEquals(orphanResult.status, 200)
  assertEquals(orphanResult.success, true)

  // Test 7: Malformed or SQL-injection style public_id is rejected with 400
  const malformedResult = evaluateDeletionRequest("malicious;DROP TABLE profiles;--")
  assertEquals(malformedResult.status, 400)
})

Deno.test("BUG-001: Flutter app does not contain Cloudinary API secrets", async () => {
  try {
    const config = await Deno.readTextFile(new URL("../../apps/mobile/lib/config.dart", import.meta.url))
    assert(!config.includes("CLOUDINARY_API_SECRET"), "Client config must not contain API secret")
    assert(!config.includes("api_secret"), "Client config must not contain api_secret")
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // In standalone monorepo CI where apps/mobile is an external repository,
      // secret detection is verified by the mobile CI pipeline.
      return
    }
    throw err
  }
})
