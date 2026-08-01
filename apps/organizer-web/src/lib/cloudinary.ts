const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]

const MAX_VIDEO_SIZE = 100 * 1024 * 1024 // 100 MB
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v", "video/ogg"]

function uploadFile(
  file: File,
  resourceType: "image" | "video",
  timeoutMs: number,
  onProgress?: (percent: number) => void,
): Promise<string> {
  const formData = new FormData()
  formData.append("file", file)
  formData.append("upload_preset", uploadPreset)
  formData.append("cloud_name", cloudName)

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
        const d = JSON.parse(xhr.responseText) as { secure_url?: string }
        if (!d.secure_url) {
          reject(new Error("Upload failed"))
          return
        }
        resolve(d.secure_url)
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
  return uploadFile(file, "image", 30_000, onProgress)
}

export function uploadVideoToCloudinary(file: File, onProgress?: (percent: number) => void): Promise<string> {
  if (!ALLOWED_VIDEO_TYPES.includes(file.type)) {
    return Promise.reject(new Error("Only MP4, WebM, MOV, M4V, and OGG videos are allowed."))
  }
  if (file.size > MAX_VIDEO_SIZE) {
    return Promise.reject(new Error("Video is too large. Maximum size is 100 MB."))
  }
  return uploadFile(file, "video", 120_000, onProgress)
}

export function videoPosterUrl(videoUrl: string): string {
  return videoUrl.replace(/\.(mp4|webm|mov|m4v|ogg)(\?.*)?$/i, ".jpg$2")
}
