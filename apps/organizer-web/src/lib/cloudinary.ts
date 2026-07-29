const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]

export function uploadToCloudinary(file: File): Promise<string> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return Promise.reject(new Error("Only JPEG, PNG, WebP, and GIF images are allowed."))
  }
  if (file.size > MAX_FILE_SIZE) {
    return Promise.reject(new Error("File is too large. Maximum size is 10 MB."))
  }

  const formData = new FormData()
  formData.append("file", file)
  formData.append("upload_preset", uploadPreset)
  formData.append("cloud_name", cloudName)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  return fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: "POST",
    body: formData,
    signal: controller.signal,
  }).then((r) => {
    clearTimeout(timeout)
    if (!r.ok) throw new Error("Upload failed")
    return r.json()
  }).then((d) => d.secure_url as string)
}
