# CLUVO STAGE 7 PHASE 2: CLOUDINARY UPLOAD SECURITY & MEDIA AUDIT (SEC-03)

**Classification:** CONFIRMED / MITIGATED RISK (Design Gap with Client Controls)  
**Severity:** MEDIUM  
**Components:**  
- `apps/mobile/lib/services/cloudinary.dart` & `cloudinary_io.dart`  
- `apps/mobile/lib/services/media_validator.dart`  
- `apps/organizer-web/src/lib/cloudinary.ts`  
- `supabase/functions/delete-media/index.ts`  
- `public.media` table RLS  
**Date:** 2026-11-01  
**Author:** Principal Security Engineer & Application Security Auditor  

---

## 1. Executive Summary

During product discovery, an investigation of Cloudinary media management across the Cluvo mobile application and organizer web platform identified that media uploads use **unsigned upload presets** (`upload_preset` and `cloud_name` publicly embedded in client apps).

Our deep audit conducted a thorough review of:
1. Secret exposure in mobile and web binaries.
2. Client-side file type and magic-byte validation.
3. Attack vectors bypassing the client application.
4. Database RLS on the `public.media` table.
5. Anti-destruction guards in the `delete-media` Supabase Edge Function.

**Audit Findings:**
- **Secret Hygiene (PASSED):** `CLOUDINARY_API_SECRET` is **strictly maintained server-side** in Supabase environment secrets. It is NOT exposed in the Flutter codebase, Web config, or client network payloads.
- **Client Validation (STRONG):** Both the mobile app (`media_validator.dart`) and web app (`cloudinary.ts`) implement comprehensive byte-level magic number checks (JPEG, PNG, WebP, GIF, MP4, WebM, MOV) and strict file size caps (10MB for images, 100MB for videos).
- **Direct Preset Abuse (CONFIRMED RISK):** Because the preset is unsigned, an attacker who extracts `cloud_name` and `upload_preset` can issue raw HTTP `POST` requests directly to `api.cloudinary.com`, bypassing the client-side validation layer unless Cloudinary preset settings enforce identical restrictions in the Cloudinary dashboard.
- **Deletion Security (STRONG):** Media deletion requires user authentication through the `delete-media` Edge Function, which executes HMAC-SHA1 signatures server-side and enforces strict anti-destruction guards prohibiting the deletion of active profile avatars, community banners, event covers, or active gallery assets.

---

## 2. Media Upload Architecture & Implementation Review

### 2.1 Mobile Application (`apps/mobile`)

The mobile client handles media uploads via `lib/services/cloudinary_io.dart` (native platforms) and `lib/services/cloudinary_web.dart` (web). Before any network upload, all byte buffers are passed to `validateImageBytes` in `lib/services/media_validator.dart`:

```dart
// Magic byte inspection in media_validator.dart
void validateImageBytes(Uint8List bytes, {String? filename}) {
  if (bytes.isEmpty) throw Exception('File is empty.');
  if (bytes.length > 10 * 1024 * 1024) throw Exception('File is too large. Maximum size is 10 MB.');
  ...
  if (!_hasValidImageMagicBytes(bytes)) {
    throw Exception('Invalid image file content. File header does not match allowed image formats.');
  }
}
```
Magic bytes verified:
- **JPEG:** `FF D8 FF`
- **PNG:** `89 50 4E 47 0D 0A 1A 0A`
- **WebP:** `52 49 46 46` (`RIFF`) + `57 45 42 50` (`WEBP`)
- **GIF:** `47 49 46 38` (`GIF8`) + `37 61` / `39 61` (`7a` / `9a`)

### 2.2 Organizer Web (`apps/organizer-web`)

In `apps/organizer-web/src/lib/cloudinary.ts`, both images and videos are verified prior to upload:
- **Images:** Size $\le 10\text{ MB}$, MIME type whitelist, and magic bytes (JPEG, PNG, WebP, GIF).
- **Videos:** Size $\le 100\text{ MB}$, MIME whitelist, and container signatures:
  - MP4 / MOV: `ftyp` at offset 4..7 (`66 74 79 70`)
  - WebM: `1A 45 DF A3`
  - Ogg: `4F 47 47 53` (`OggS`)
  - QuickTime: `6D 6F 6F 76` (`moov`)

### 2.3 Upload Protocol

Both clients construct an unsigned HTTP `multipart/form-data` POST request to:
```
POST https://api.cloudinary.com/v1_1/<cloud_name>/<resource_type>/upload
```
Form fields sent:
- `file`: Raw binary data.
- `upload_preset`: The public unsigned preset identifier.
- `cloud_name`: Cloudinary account cloud identifier.

---

## 3. Vulnerability Analysis: Direct API Bypass

Because the upload preset is configured as **unsigned** in Cloudinary, Cloudinary accepts incoming uploads without an HMAC signature.

### 3.1 Attack Vector
An attacker can extract the `cloud_name` and `upload_preset` from the web network tab or mobile app bundle. They can then execute:

```bash
curl -X POST https://api.cloudinary.com/v1_1/<cloud_name>/image/upload \
  -F "file=@malicious_payload.exe" \
  -F "upload_preset=<unsigned_preset>"
```

### 3.2 Consequences of Bypass
1. **Quota Exhaustion (Denial of Wallet/Service):** An adversary could upload excessive high-volume files, rapidly consuming the organization's monthly Cloudinary bandwidth and storage transformation units.
2. **Arbitrary File Storage:** If the unsigned preset in the Cloudinary console does not enforce strict format whitelisting (`allowed_formats`), malicious executables, PDFs, or phishing assets could be hosted under the project's Cloudinary domain.
3. **Database Injection Defense:** Even if an attacker uploads a file to Cloudinary, inserting it into Cluvo's `public.media` table requires authentication under Supabase RLS. An unauthenticated attacker cannot link the uploaded file to Cluvo events or communities.

---

## 4. Deletion Protection & Anti-Destruction Guards

The deletion lifecycle is fully protected and does not suffer from client-side vulnerability.

### 4.1 Server-Side HMAC Signature in `delete-media` Edge Function
In `supabase/functions/delete-media/index.ts`:
- The client cannot delete media from Cloudinary directly.
- The client must call the `delete-media` Edge Function with a valid Supabase JWT (`auth.getUser(token)`).
- The Edge Function calculates an HMAC-SHA1 signature using `CLOUDINARY_API_SECRET` and calls Cloudinary's admin destroy API (`https://api.cloudinary.com/v1_1/<cloud>/image/destroy`).

### 4.2 Anti-Destruction Invariants
Before issuing any destroy request to Cloudinary, `delete-media` executes rigorous safety checks:
1. **Active Avatar Guard:** Queries `profiles` table. Rejects deletion if the asset is currently an active user avatar (`avatar_url ILIKE %public_id%`).
2. **Community Asset Guard:** Queries `communities` table. Rejects deletion if the asset is an active `banner_url` or `community_avatar_url`.
3. **Event Asset Guard:** Queries `events` table. Rejects deletion if the asset is an active `cover_image_url` or event banner.
4. **Rate Limiting:** Enforces rate limits per authenticated user ID.

---

## 5. Security Recommendations & Hardening Plan

We classify the remediation into two actionable tiers:

### Tier 1: Cloudinary Console Hardening (Zero Code Changes — Immediate)
In the Cloudinary management console for the unsigned preset:
1. **Restrict Allowed Formats:** Configure `Allowed formats` to strictly `jpg, jpeg, png, webp, gif` for the image preset, and `mp4, webm, mov` for the video preset.
2. **Maximum File Size Limit:** Set strict size limits at the Cloudinary preset level (10MB for images, 100MB for videos).
3. **Incoming Transformations:** Apply automatic WebP transcoding and maximum dimension limits (e.g. `c_limit,w_2048,h_2048`).
4. **Disable PDF / Archive Execution:** Prevent delivery of non-media assets.

### Tier 2: Signed Ephemeral Uploads (Recommended Architecture for Future Hardening)
Transition from unsigned presets to signed uploads:
1. Create a lightweight Supabase Edge Function: `generate-upload-signature`.
2. When a user wishes to upload, the client calls `generate-upload-signature` with the desired `resource_type` and `folder`.
3. The Edge Function verifies user session (`auth.uid()`), checks rate limits, and returns:
   - `timestamp`
   - `signature` (HMAC-SHA1 of params with `CLOUDINARY_API_SECRET`)
   - `api_key`
4. The client uploads directly to Cloudinary using the signature. Unsigned presets are completely disabled in Cloudinary settings.

