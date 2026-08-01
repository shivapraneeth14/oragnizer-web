import { useState, useEffect } from "react"
import { useProfile } from "../../hooks/use-profile"

function isValidUrl(url: string): boolean {
  if (!url) return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

interface FieldState {
  value: string
  error: string
}

function validate(fields: Record<string, FieldState>): boolean {
  let valid = true
  for (const f of Object.values(fields)) {
    f.error = f.value && !isValidUrl(f.value) ? "Enter a valid http/https URL" : ""
    if (f.error) valid = false
  }
  return valid
}

export default function SocialMedia() {
  const { community, saving, error, success, updateCommunity, clearMessages } = useProfile()

  const [fields, setFields] = useState<Record<string, FieldState>>({
    instagram_url: { value: "", error: "" },
    facebook_url: { value: "", error: "" },
    twitter_url: { value: "", error: "" },
    linkedin_url: { value: "", error: "" },
  })

  useEffect(() => {
    if (community) {
      setFields({
        instagram_url: { value: community.instagram_url || "", error: "" },
        facebook_url: { value: community.facebook_url || "", error: "" },
        twitter_url: { value: community.twitter_url || "", error: "" },
        linkedin_url: { value: community.linkedin_url || "", error: "" },
      })
    }
  }, [community])

  useEffect(() => {
    if (success || error) {
      const t = setTimeout(clearMessages, 3000)
      return () => clearTimeout(t)
    }
  }, [success, error, clearMessages])

  const handleChange = (key: string, value: string) => {
    setFields((prev) => ({
      ...prev,
      [key]: { value, error: prev[key]?.error || "" },
    }))
  }

  const handleBlur = (key: string) => {
    setFields((prev) => {
      const f = prev[key]
      if (!f) return prev
      return {
        ...prev,
        [key]: { ...f, error: f.value && !isValidUrl(f.value) ? "Enter a valid http/https URL" : "" },
      }
    })
  }

  const handleSave = () => {
    const updated = { ...fields }
    const allValid = validate(updated)
    setFields(updated)
    if (!allValid) return
    updateCommunity({
      instagram_url: updated.instagram_url.value.trim() || null,
      facebook_url: updated.facebook_url.value.trim() || null,
      twitter_url: updated.twitter_url.value.trim() || null,
      linkedin_url: updated.linkedin_url.value.trim() || null,
    })
  }

  const platformLabels: Record<string, { label: string; placeholder: string }> = {
    instagram_url: { label: "Instagram", placeholder: "https://instagram.com/yourpage" },
    facebook_url: { label: "Facebook", placeholder: "https://facebook.com/yourpage" },
    twitter_url: { label: "Twitter / X", placeholder: "https://twitter.com/yourpage" },
    linkedin_url: { label: "LinkedIn", placeholder: "https://linkedin.com/company/yourpage" },
  }

  const allValid = Object.values(fields).every((f) => !f.value || isValidUrl(f.value))

  return (
    <div>
      <h3 className="text-xl font-semibold text-neutral-900">Social Media</h3>
      <p className="mt-1 text-sm text-neutral-500">Link your community's social profiles.</p>

      {error && (
        <div className="mt-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">{error}</div>
      )}
      {success && (
        <div className="mt-4 rounded-lg bg-green-50 px-4 py-2 text-sm text-green-600">{success}</div>
      )}

      <div className="mt-6 space-y-5">
        {Object.entries(platformLabels).map(([key, { label, placeholder }]) => {
          const f = fields[key]
          return (
            <div key={key}>
              <label className="mb-1 block text-xs font-medium text-neutral-500">{label}</label>
              <input
                value={f?.value || ""}
                onChange={(e) => handleChange(key, e.target.value)}
                onBlur={() => handleBlur(key)}
                placeholder={placeholder}
                className={`w-full rounded-lg border px-3.5 py-2 text-sm outline-none transition focus:ring-1 focus:ring-[#C2185B]/20 ${
                  f?.error ? "border-red-400 focus:border-red-500" : "border-neutral-300 focus:border-[#C2185B]"
                }`}
              />
              {f?.error && <p className="mt-0.5 text-xs text-red-500">{f.error}</p>}
            </div>
          )
        })}
      </div>

      <div className="mt-6">
        <button
          onClick={handleSave}
          disabled={saving || !allValid}
          className="rounded-lg bg-[#C2185B] px-6 py-2.5 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  )
}
