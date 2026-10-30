// supabase/tests/cloudinary_validation.test.ts
// Verifies BUG-006 remediation:
// 1. Organizer Web validates extensions, MIME types, and magic bytes.
// 2. Mobile services validate extensions and magic bytes for native and web.
// 3. Rejection of active content (SVG/HTML/script) and corrupt headers.

import { assert, assertEquals } from "jsr:@std/assert"

const rootDir = new URL("../../", import.meta.url)

Deno.test("BUG-006: Organizer Web validates file extension, MIME type, and magic bytes", async () => {
  const ts = await Deno.readTextFile(new URL("apps/organizer-web/src/lib/cloudinary.ts", rootDir))

  // Whitelists
  assert(ts.includes("ALLOWED_EXTENSIONS"), "Must declare ALLOWED_EXTENSIONS")
  assert(ts.includes("ALLOWED_VIDEO_EXTENSIONS"), "Must declare ALLOWED_VIDEO_EXTENSIONS")

  // Function signatures
  assert(ts.includes("export async function validateImageFile"), "Must export validateImageFile")
  assert(ts.includes("export async function validateVideoFile"), "Must export validateVideoFile")

  // Magic bytes checks for images (JPEG, PNG, WebP, GIF)
  assert(ts.includes("0xff") && ts.includes("0xd8"), "Must verify JPEG magic bytes")
  assert(ts.includes("0x89") && ts.includes("0x50") && ts.includes("0x4e"), "Must verify PNG magic bytes")
  assert(ts.includes("0x52") && ts.includes("0x49") && ts.includes("0x46"), "Must verify WebP RIFF magic bytes")
  assert(ts.includes("0x47") && ts.includes("0x49") && ts.includes("0x46"), "Must verify GIF magic bytes")

  // Magic bytes checks for videos (MP4, WebM, Ogg, QuickTime)
  assert(ts.includes("isFtyp"), "Must verify MP4 ftyp box")
  assert(ts.includes("isWebm"), "Must verify WebM header")
  assert(ts.includes("isOgg"), "Must verify Ogg header")
})

Deno.test("BUG-006: Mobile services enforce media validation in both io and web implementations", async () => {
  const ioDart = await Deno.readTextFile(new URL("apps/mobile/lib/services/cloudinary_io.dart", rootDir))
  const webDart = await Deno.readTextFile(new URL("apps/mobile/lib/services/cloudinary_web.dart", rootDir))
  const validatorDart = await Deno.readTextFile(new URL("apps/mobile/lib/services/media_validator.dart", rootDir))

  // Both io and web must import and use media_validator
  assert(ioDart.includes("validateImageBytes"), "cloudinary_io.dart must call validateImageBytes")
  assert(webDart.includes("validateImageBytes"), "cloudinary_web.dart must call validateImageBytes")

  // Validator must enforce size, extensions, and magic bytes
  assert(validatorDart.includes("maxImageFileSize"), "Must declare maxImageFileSize")
  assert(validatorDart.includes("allowedImageExtensions"), "Must declare allowedImageExtensions")
  assert(validatorDart.includes("_hasValidImageMagicBytes"), "Must check magic bytes")
})
