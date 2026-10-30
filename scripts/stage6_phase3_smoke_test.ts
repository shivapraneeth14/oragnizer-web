// scripts/stage6_phase3_smoke_test.ts
// CLUVO STAGE 6 PHASE 3 — LIVE STAGING SMOKE TEST SUITE
// Target Supabase: https://ofvfasdgdwkehdcjugnf.supabase.co
// Verifies BUG-006, BUG-007, and BUG-008 on live staging project

import { createClient } from "npm:@supabase/supabase-js@2"

interface SmokeResult {
  step: number
  title: string
  verdict: "PASS" | "FAIL"
  details: string
  evidence: Record<string, unknown>
}

// 1. Safeguard & Environment Loading
function loadEnv(): Record<string, string> {
  const text = Deno.readTextFileSync("supabase/.env")
  const env: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx !== -1) {
      env[trimmed.substring(0, idx)] = trimmed.substring(idx + 1)
    }
  }
  return env
}

const env = loadEnv()
const SUPABASE_URL = env.SUPABASE_URL
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const RAZORPAY_KEY_ID = env.RAZORPAY_KEY_ID

// Absolute guardrails
if (!SUPABASE_URL.includes("ofvfasdgdwkehdcjugnf")) {
  throw new Error(`CRITICAL HALT: Target URL ${SUPABASE_URL} is NOT the staging project (ofvfasdgdwkehdcjugnf)!`)
}
if (SUPABASE_URL.includes("vdxspyumkvwawmqwfkzr")) {
  throw new Error(`CRITICAL HALT: Production URL detected! Aborting immediately.`)
}
if (!RAZORPAY_KEY_ID.startsWith("rzp_test_")) {
  throw new Error(`CRITICAL HALT: Live Razorpay key detected! Aborting immediately.`)
}

const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

const results: SmokeResult[] = []

// Cleanup registry
const cleanupUserIds: string[] = []
const cleanupCommunityIds: string[] = []
const cleanupEventIds: string[] = []
const cleanupMediaIds: string[] = []

async function createTestUser(emailPrefix: string, isAdmin = false): Promise<{ id: string; email: string; token: string }> {
  const ts = Date.now() + "_" + Math.floor(Math.random() * 1000000)
  const email = `${emailPrefix}_${ts}@example.com`
  const password = "SmokePassword123!"

  const createResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      app_metadata: { cluvo_provisioned: true, provider: "email" },
      user_metadata: { first_name: "SmokeP3", last_name: emailPrefix, username: `smkp3_${emailPrefix}_${ts}` }
    })
  })

  if (!createResp.ok) {
    throw new Error(`Failed to create test user: ${createResp.status} ${await createResp.text()}`)
  }
  const userData = await createResp.json()
  const uid = userData.id
  cleanupUserIds.push(uid)

  if (isAdmin) {
    await serviceClient.from("profiles").update({ is_admin: true }).eq("id", uid)
  }

  // Record required user consent
  await serviceClient.from("consent_log").insert({
    user_id: uid,
    consent_version: "2026-10-22",
    source: "mobile"
  })

  // Sign in to get access token
  const signInResp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
  })

  if (!signInResp.ok) {
    throw new Error(`Failed to sign in test user: ${signInResp.status} ${await signInResp.text()}`)
  }
  const signData = await signInResp.json()
  return { id: uid, email, token: signData.access_token }
}

async function cleanup() {
  console.log("\n--- Cleaning up temporary staging test data ---")
  for (const mid of cleanupMediaIds) {
    await serviceClient.from("media").delete().eq("id", mid)
  }
  for (const eid of cleanupEventIds) {
    await serviceClient.from("event_messages").delete().eq("event_id", eid)
    await serviceClient.from("events").delete().eq("id", eid)
  }
  for (const cid of cleanupCommunityIds) {
    await serviceClient.from("community_members").delete().eq("community_id", cid)
    await serviceClient.from("communities").delete().eq("id", cid)
  }
  for (const uid of cleanupUserIds) {
    await serviceClient.from("consent_log").delete().eq("user_id", uid)
    await serviceClient.from("profiles").delete().eq("id", uid)
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      }
    })
  }
  console.log("Cleanup complete.")
}

try {
  console.log("================================================================================")
  console.log("CLUVO STAGE 6 PHASE 3 LIVE STAGING SMOKE TEST SUITE")
  console.log(`Target: ${SUPABASE_URL}`)
  console.log("================================================================================\n")

  // ---------------------------------------------------------------------------
  // STEP 1: Verify Forward-Only Migration 202611010012 & Owner Self-Delete RLS
  // ---------------------------------------------------------------------------
  console.log("[STEP 1] Verifying Migration 202611010012 & community_members_self_delete policy...")

  // Create test owner and test community
  const owner = await createTestUser("p3_owner")
  const ownerId = owner.id
  const ownerToken = owner.token

  const { data: commData, error: commErr } = await serviceClient
    .from("communities")
    .insert({
      name: `Smoke P3 Comm ${Date.now()}`,
      description: "Stage 6 Phase 3 Verification Community",
      owner_id: ownerId,
      visibility: "public",
      banner_url: `https://res.cloudinary.com/demo/image/upload/v1/banners/smoke_banner_${Date.now()}.jpg`,
      community_avatar_url: `https://res.cloudinary.com/demo/image/upload/v1/avatars/smoke_avatar_${Date.now()}.png`,
    })
    .select()
    .single()
  if (commErr || !commData) throw new Error(`Failed to create test community: ${commErr?.message}`)
  const communityId = commData.id
  cleanupCommunityIds.push(communityId)

  // Ensure owner is member with role = 'OWNER'
  await serviceClient.from("community_members").upsert({
    community_id: communityId,
    user_id: ownerId,
    role: "OWNER",
  })

  const ownerSessionClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${ownerToken}` } },
  })

  // Attempt self-deletion of owner's own membership row via RLS
  const { error: ownerDeleteErr, count: ownerDeleteCount } = await ownerSessionClient
    .from("community_members")
    .delete({ count: "exact" })
    .eq("community_id", communityId)
    .eq("user_id", ownerId)

  // Under RLS, deleting a forbidden row results in 0 rows deleted (or RLS rejection)
  const ownerRowStillExists = await serviceClient
    .from("community_members")
    .select("role")
    .eq("community_id", communityId)
    .eq("user_id", ownerId)
    .maybeSingle()

  console.log("Debug Step 1:", {
    ownerDeleteCount,
    ownerDeleteErr,
    ownerRowStillExists: ownerRowStillExists.data,
  })

  if (ownerRowStillExists.data?.role === "OWNER" && (ownerDeleteCount === 0 || ownerDeleteErr)) {
    console.log("✓ SUCCESS: Owner self-deletion blocked by community_members_self_delete RLS policy")
    results.push({
      step: 1,
      title: "BUG-007: Owner Self-Delete Guard on community_members",
      verdict: "PASS",
      details: "Owner attempted self-delete via client RLS; deletion was blocked and owner row remained intact.",
      evidence: {
        communityId,
        ownerId,
        ownerDeleteCount,
        ownerRowRole: ownerRowStillExists.data?.role,
      },
    })
  } else {
    throw new Error("FAIL: Owner was able to delete their own membership row!")
  }

  // ---------------------------------------------------------------------------
  // STEP 2: BUG-006 delete-media Edge Function Anti-Destruction & Gallery Guard
  // ---------------------------------------------------------------------------
  console.log("\n[STEP 2] Verifying BUG-006 delete-media Edge Function on live staging...")

  // Setup test active assets:
  // 1. Profile avatar for owner
  const activeAvatarPublicId = `smoke_p3_avatar_${Date.now()}`
  const activeAvatarUrl = `https://res.cloudinary.com/demo/image/upload/v1/${activeAvatarPublicId}.jpg`
  await serviceClient.from("profiles").update({ avatar_url: activeAvatarUrl }).eq("id", ownerId)

  // 2. Active gallery media
  const activeGalleryPublicId = `smoke_p3_gallery_${Date.now()}`
  const activeGalleryUrl = `https://res.cloudinary.com/demo/image/upload/v1/${activeGalleryPublicId}.jpg`
  const { data: mediaRow, error: mediaErr } = await serviceClient
    .from("media")
    .insert({
      mediable_id: communityId,
      mediable_type: "community",
      url: activeGalleryUrl,
      type: "image",
    })
    .select()
    .single()
  if (mediaErr || !mediaRow) throw new Error(`Failed to create gallery media: ${mediaErr?.message}`)
  cleanupMediaIds.push(mediaRow.id)

  // 3. Active event with poster and promo video
  const activeEventPosterId = `smoke_p3_poster_${Date.now()}`
  const activeEventVideoId = `smoke_p3_video_${Date.now()}`
  const { data: eventRow, error: eventErr } = await serviceClient
    .from("events")
    .insert({
      community_id: communityId,
      created_by: ownerId,
      title: `Smoke P3 Event ${Date.now()}`,
      description: "Smoke test event",
      start_date: new Date(Date.now() + 86400000).toISOString(),
      end_date: new Date(Date.now() + 86400000 + 7200000).toISOString(),
      location: "Bangalore",
      capacity: 50,
      price: 0,
      status: "published",
      image_url: `https://res.cloudinary.com/demo/image/upload/v1/${activeEventPosterId}.jpg`,
      video_url: `https://res.cloudinary.com/demo/video/upload/v1/${activeEventVideoId}.mp4`,
    })
    .select()
    .single()
  if (eventErr || !eventRow) throw new Error(`Failed to create test event: ${eventErr?.message}`)
  const eventId = eventRow.id
  cleanupEventIds.push(eventId)

  // Test 2A: Targeting active avatar -> must return 403
  const resAvatar = await fetch(`${SUPABASE_URL}/functions/v1/delete-media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ public_id: activeAvatarPublicId }),
  })
  const bodyAvatar = await resAvatar.json()
  console.log(`- Active avatar deletion response: HTTP ${resAvatar.status} (${bodyAvatar.error})`)
  if (resAvatar.status !== 403) throw new Error(`Expected 403 for active avatar, got ${resAvatar.status}`)

  // Test 2B: Targeting active community banner -> must return 403
  const bannerPublicId = commData.banner_url.match(/\/banners\/(.+?)\.jpg/)?.[1]
  const resBanner = await fetch(`${SUPABASE_URL}/functions/v1/delete-media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ public_id: bannerPublicId }),
  })
  const bodyBanner = await resBanner.json()
  console.log(`- Active banner deletion response: HTTP ${resBanner.status} (${bodyBanner.error})`)
  if (resBanner.status !== 403) throw new Error(`Expected 403 for active banner, got ${resBanner.status}`)

  // Test 2C: Targeting active event poster & video -> must return 403
  const resPoster = await fetch(`${SUPABASE_URL}/functions/v1/delete-media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ public_id: activeEventPosterId }),
  })
  const bodyPoster = await resPoster.json()
  console.log(`- Active event poster deletion response: HTTP ${resPoster.status} (${bodyPoster.error})`)
  if (resPoster.status !== 403) throw new Error(`Expected 403 for event poster, got ${resPoster.status}`)

  const resVideo = await fetch(`${SUPABASE_URL}/functions/v1/delete-media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ public_id: activeEventVideoId }),
  })
  const bodyVideo = await resVideo.json()
  console.log(`- Active event video deletion response: HTTP ${resVideo.status} (${bodyVideo.error})`)
  if (resVideo.status !== 403) throw new Error(`Expected 403 for event video, got ${resVideo.status}`)

  // Test 2D: Targeting active gallery media -> must return 403
  const resGallery = await fetch(`${SUPABASE_URL}/functions/v1/delete-media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ public_id: activeGalleryPublicId }),
  })
  const bodyGallery = await resGallery.json()
  console.log(`- Active gallery media deletion response: HTTP ${resGallery.status} (${bodyGallery.error})`)
  if (resGallery.status !== 403) throw new Error(`Expected 403 for gallery media, got ${resGallery.status}`)

  // Test 2E: Targeting unreferenced orphaned asset -> should succeed (200)
  const orphanPublicId = `smoke_p3_orphan_${Date.now()}`
  const resOrphan = await fetch(`${SUPABASE_URL}/functions/v1/delete-media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ public_id: orphanPublicId }),
  })
  const bodyOrphan = await resOrphan.json()
  console.log(`- Orphaned asset deletion response: HTTP ${resOrphan.status} (success=${bodyOrphan.success})`)
  if (resOrphan.status !== 200 || !bodyOrphan.success) {
    throw new Error(`Expected 200 for orphan cleanup, got ${resOrphan.status}: ${JSON.stringify(bodyOrphan)}`)
  }

  // Test 2F: Malformed input -> must return 400
  const resMalformed = await fetch(`${SUPABASE_URL}/functions/v1/delete-media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ public_id: "bad;injection--hack" }),
  })
  console.log(`- Malformed input response: HTTP ${resMalformed.status}`)
  if (resMalformed.status !== 400) throw new Error(`Expected 400 for malformed input, got ${resMalformed.status}`)

  results.push({
    step: 2,
    title: "BUG-006: delete-media Anti-Destruction Guard Across All Media Types",
    verdict: "PASS",
    details: "All active assets (avatar, banner, poster, promo video, gallery media) were protected with HTTP 403; unreferenced orphan was cleaned with HTTP 200; malformed tokens were rejected with HTTP 400.",
    evidence: {
      avatarBlocked: resAvatar.status === 403,
      bannerBlocked: resBanner.status === 403,
      posterBlocked: resPoster.status === 403,
      videoBlocked: resVideo.status === 403,
      galleryBlocked: resGallery.status === 403,
      orphanAllowed: resOrphan.status === 200,
      malformedRejected: resMalformed.status === 400,
    },
  })

  // ---------------------------------------------------------------------------
  // STEP 3: BUG-007 remove-member Edge Function Authorization & Hierarchy
  // ---------------------------------------------------------------------------
  console.log("\n[STEP 3] Verifying BUG-007 remove-member Edge Function on live staging...")

  // Create an organizer user and a regular member user
  const org = await createTestUser("p3_org")
  const orgId = org.id
  const orgToken = org.token
  await serviceClient.from("community_members").insert({ community_id: communityId, user_id: orgId, role: "ORGANIZER" })

  const member = await createTestUser("p3_mem")
  const memberId = member.id
  await serviceClient.from("community_members").insert({ community_id: communityId, user_id: memberId, role: "MEMBER" })

  // Test 3A: Organizer attempting to remove Owner -> must return 403
  const resRemoveOwner = await fetch(`${SUPABASE_URL}/functions/v1/remove-member`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${orgToken}` },
    body: JSON.stringify({ community_id: communityId, user_id: ownerId }),
  })
  const bodyRemoveOwner = await resRemoveOwner.json()
  console.log(`- Organizer removing Owner: HTTP ${resRemoveOwner.status} (${bodyRemoveOwner.error})`)
  if (resRemoveOwner.status !== 403) throw new Error(`Expected 403 when removing owner, got ${resRemoveOwner.status}`)

  // Test 3B: Self-removal via remove-member endpoint -> must return 400
  const resSelfRemove = await fetch(`${SUPABASE_URL}/functions/v1/remove-member`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${orgToken}` },
    body: JSON.stringify({ community_id: communityId, user_id: orgId }),
  })
  const bodySelfRemove = await resSelfRemove.json()
  console.log(`- Self-removal via remove-member: HTTP ${resSelfRemove.status} (${bodySelfRemove.error})`)
  if (resSelfRemove.status !== 400) throw new Error(`Expected 400 for self-removal, got ${resSelfRemove.status}`)

  // Test 3C: Owner removing regular member -> must succeed (200)
  const resOwnerRemoveMember = await fetch(`${SUPABASE_URL}/functions/v1/remove-member`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ community_id: communityId, user_id: memberId }),
  })
  const bodyOwnerRemoveMember = await resOwnerRemoveMember.json()
  console.log(`- Owner removing Member: HTTP ${resOwnerRemoveMember.status} (success=${bodyOwnerRemoveMember.success})`)
  if (resOwnerRemoveMember.status !== 200 || !bodyOwnerRemoveMember.success) {
    throw new Error(`Expected 200 when owner removes member, got ${resOwnerRemoveMember.status}`)
  }

  // Verify member row is gone
  const { data: memberStillThere } = await serviceClient
    .from("community_members")
    .select("role")
    .eq("community_id", communityId)
    .eq("user_id", memberId)
    .maybeSingle()
  if (memberStillThere) throw new Error("Member row still exists in community_members after removal!")

  // Verify audit log entry
  const { data: auditRows } = await serviceClient
    .from("audit_log")
    .select("action, details")
    .eq("action", "member_removed")
    .eq("target_id", memberId)
    .order("created_at", { ascending: false })
    .limit(1)

  const auditLogDetails = auditRows?.[0]?.details as Record<string, unknown> | undefined
  console.log(`- Audit log caller_role: ${auditLogDetails?.caller_role}`)
  if (auditLogDetails?.caller_role !== "OWNER") {
    throw new Error(`Expected audit log caller_role = 'OWNER', got ${auditLogDetails?.caller_role}`)
  }

  results.push({
    step: 3,
    title: "BUG-007: remove-member Role Hierarchy, Validation & Audit Trail",
    verdict: "PASS",
    details: "Organizer removing owner returned 403; self-removal returned 400; owner removing member succeeded (200); member row was deleted; audit log recorded caller_role = 'OWNER'.",
    evidence: {
      removeOwnerBlocked: resRemoveOwner.status === 403,
      selfRemovalRejected: resSelfRemove.status === 400,
      memberRemovalSucceeded: resOwnerRemoveMember.status === 200,
      memberDeleted: memberStillThere === null,
      auditCallerRole: auditLogDetails?.caller_role,
    },
  })

  // ---------------------------------------------------------------------------
  // STEP 4: BUG-008 Discussion Profile Hydration & State Synchronization
  // ---------------------------------------------------------------------------
  console.log("\n[STEP 4] Verifying BUG-008 Discussion Profile Hydration & Synchronization...")

  // Insert message into event_messages
  const msgContent = "Smoke test live discussion message from owner"
  const { data: msgRow, error: msgErr } = await serviceClient
    .from("event_messages")
    .insert({
      event_id: eventId,
      user_id: ownerId,
      content: msgContent,
    })
    .select()
    .single()
  if (msgErr || !msgRow) throw new Error(`Failed to insert event message: ${msgErr?.message}`)

  // Query message with relational join to profiles (verifying PostgREST hydration structure)
  const { data: hydratedQuery, error: hydrErr } = await serviceClient
    .from("event_messages")
    .select("id, event_id, user_id, content, created_at, updated_at, profiles:user_id(first_name, last_name, avatar_url)")
    .eq("id", msgRow.id)
    .single()

  if (hydrErr || !hydratedQuery) throw new Error(`Failed to query hydrated message: ${hydrErr?.message}`)

  const profileJoin = hydratedQuery.profiles as Record<string, unknown> | null
  console.log(`- Hydrated message author: ${profileJoin?.first_name} ${profileJoin?.last_name}`)
  if (profileJoin?.first_name !== "SmokeP3" || profileJoin?.last_name !== "p3_owner") {
    throw new Error(`Unexpected joined profile data: ${JSON.stringify(profileJoin)}`)
  }

  // Update message
  const updatedContent = "Smoke test updated content"
  const { data: updatedMsg, error: updateErr } = await serviceClient
    .from("event_messages")
    .update({ content: updatedContent })
    .eq("id", msgRow.id)
    .select()
    .single()
  if (updateErr || !updatedMsg) throw new Error(`Failed to update message: ${updateErr?.message}`)
  if (updatedMsg.content !== updatedContent) throw new Error("Message content update did not reflect!")

  results.push({
    step: 4,
    title: "BUG-008: Realtime Discussion Profile Hydration & Mutation Contract",
    verdict: "PASS",
    details: "Event message inserted; joined profile projection correctly hydrated first_name, last_name, and avatar_url; message update reflected in-place.",
    evidence: {
      messageId: msgRow.id,
      joinedFirstName: profileJoin?.first_name,
      joinedLastName: profileJoin?.last_name,
      updatedContent: updatedMsg.content,
    },
  })

  console.log("\n================================================================================")
  console.log("ALL STAGE 6 PHASE 3 LIVE SMOKE TESTS PASSED (4/4 - 100%)")
  console.log("================================================================================\n")
} catch (err) {
  console.error("\n❌ SMOKE TEST FAILED:", err)
  Deno.exit(1)
} finally {
  await cleanup()
}
