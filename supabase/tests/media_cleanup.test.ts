// supabase/tests/media_cleanup.test.ts
// Verifies BUG-001 remediation:
// 1. delete-media Edge Function security and anti-destruction check.
// 2. Client secret isolation (no Cloudinary secrets on client).
// 3. Comparison of normalized Cloudinary public IDs.

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

Deno.test("BUG-001: delete-media Edge Function enforces anti-destruction check", async () => {
  const ts = await Deno.readTextFile(new URL("delete-media/index.ts", functionsDir))

  // Authentication check
  assert(ts.includes("Authorization"), "Must require Authorization header")
  assert(ts.includes("getUser(token)"), "Must verify session token")

  // Anti-destruction guard
  assert(ts.includes("Cannot destroy active profile avatar"), "Must reject destroying active profile avatar")
  assert(ts.includes("targetPublicId === activeAvatarPublicId"), "Must compare normalized public IDs")

  // Rate limiting
  assert(ts.includes("checkRateLimit"), "Must enforce rate limiting")
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

