import { env } from "../config"

const cloudName = env.cloudinaryCloudName
const uploadPreset = env.cloudinaryUploadPreset

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]

const MAX_VIDEO_SIZE = 100 * 1024 * 1024 // 100 MB
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v", "video/ogg"]

// NOTE: Cloudinary rejects the `eager` upload parameter on unsigned uploads
// ("Eager parameter is not allowed when using unsigned upload"), so the
// 1080p derivative must be configured on the upload preset itself (dashboard:
// preset → incoming transformation `w_1080,q_auto`). Until then, every stored
// URL is rewritten to the on-the-fly `w_1080,q_auto` derivative at delivery
// (see cloudinaryPlayableVideoUrl), which the mobile app also applies.
const MAX_VIDEO_LONG_EDGE = 3840 // reject 8K+ originals

interface UploadResult {
  secureUrl: string
  eagerUrl?: string
}

function uploadFile(
  file: File,
  resourceType: "image" | "video",
  timeoutMs: number,
  onProgress?: (percent: number) => void,
  extraParams: Record<string, string> = {},
): Promise<UploadResult> {
  const formData = new FormData()
  formData.append("file", file)
  formData.append("upload_preset", uploadPreset)
  formData.append("cloud_name", cloudName)
  for (const [key, value] of Object.entries(extraParams)) {
    formData.append(key, value)
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`)
    xhr.timeout = timeoutMs
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error("Upload failed"))
        return
      }
      try {
        const d = JSON.parse(xhr.responseText) as {
          secure_url?: string
          eager?: Array<{ secure_url?: string }>
        }
        if (!d.secure_url) {
          reject(new Error("Upload failed"))
          return
        }
        resolve({
          secureUrl: d.secure_url,
          eagerUrl: d.eager?.[0]?.secure_url,
        })
      } catch {
        reject(new Error("Upload failed"))
      }
    }
    xhr.onerror = () => reject(new Error("Upload failed"))
    xhr.ontimeout = () => reject(new Error("Upload timed out"))
    xhr.send(formData)
  })
}

export function uploadToCloudinary(file: File, onProgress?: (percent: number) => void): Promise<string> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return Promise.reject(new Error("Only JPEG, PNG, WebP, and GIF images are allowed."))
  }
  if (file.size > MAX_FILE_SIZE) {
    return Promise.reject(new Error("File is too large. Maximum size is 10 MB."))
  }
  return uploadFile(file, "image", 30_000, onProgress).then((r) => r.secureUrl)
}

function videoDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const video = document.createElement("video")
    video.preload = "metadata"
    video.muted = true
    video.onloadedmetadata = () => {
      const dims = { width: video.videoWidth, height: video.videoHeight }
      URL.revokeObjectURL(objectUrl)
      resolve(dims)
    }
    video.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error("Could not read video file."))
    }
    video.src = objectUrl
  })
}

// Same rewrite as the mobile app: point a raw Cloudinary video URL at its
// 1080p derivative (used as the fallback when the eager URL is unavailable).
export function cloudinaryPlayableVideoUrl(url: string): string {
  const marker = "/video/upload/"
  const idx = url.indexOf(marker)
  if (idx < 0) return url
  const rest = url.slice(idx + marker.length)
  if (!/^v\d+\//.test(rest)) return url // transformation already present
  const noExt = rest.replace(/\.[A-Za-z0-9]{2,5}(\?.*)?$/, "")
  return url.slice(0, idx + marker.length) + "w_1080,q_auto/" + noExt + ".mp4"
}

export async function uploadVideoToCloudinary(file: File, onProgress?: (percent: number) => void): Promise<string> {
  if (!ALLOWED_VIDEO_TYPES.includes(file.type)) {
    return Promise.reject(new Error("Only MP4, WebM, MOV, M4V, and OGG videos are allowed."))
  }
  if (file.size > MAX_VIDEO_SIZE) {
    return Promise.reject(new Error("Video is too large. Maximum size is 100 MB."))
  }
  try {
    const dims = await videoDimensions(file)
    if (dims.width > 0 && dims.height > 0 && Math.max(dims.width, dims.height) > MAX_VIDEO_LONG_EDGE) {
      return Promise.reject(new Error("Videos above 4K resolution are not supported."))
    }
  } catch {
    // metadata unreadable — proceed; size/type checks already passed
  }
  const result = await uploadFile(file, "video", 120_000, onProgress)
  return result.eagerUrl ?? cloudinaryPlayableVideoUrl(result.secureUrl)
}

export function videoPosterUrl(videoUrl: string): string {
  return videoUrl.replace(/\.(mp4|webm|mov|m4v|ogg)(\?.*)?$/i, ".jpg$2")
}
