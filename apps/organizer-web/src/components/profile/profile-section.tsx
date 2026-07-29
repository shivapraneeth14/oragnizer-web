import { useState, useEffect, useRef } from "react"
import { useAuth } from "../../auth-context"
import { useProfile } from "../../hooks/use-profile"
import { uploadToCloudinary } from "../../lib/cloudinary"

export default function ProfileSection() {
  const { user } = useAuth()
  const { profile, community, loading, saving, error, success, updateProfile, updateBanner, updateCommunity, clearMessages } = useProfile()
  const [editing, setEditing] = useState(false)
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [username, setUsername] = useState("")
  const [uploading, setUploading] = useState(false)
  const [uploadingBanner, setUploadingBanner] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)

  const [communityEditing, setCommunityEditing] = useState(false)
  const [commName, setCommName] = useState("")
  const [commDesc, setCommDesc] = useState("")
  const [commCategory, setCommCategory] = useState("")
  const [commCity, setCommCity] = useState("")
  const [commState, setCommState] = useState("")
  const [commCountry, setCommCountry] = useState("")
  const [commEmail, setCommEmail] = useState("")
  const [commPhone, setCommPhone] = useState("")
  const [commVisibility, setCommVisibility] = useState<"public" | "private">("public")

  useEffect(() => {
    if (profile) {
      setFirstName(profile.first_name || "")
      setLastName(profile.last_name || "")
      setUsername(profile.username || "")
    }
  }, [profile])

  useEffect(() => {
    if (community) {
      setCommName(community.name || "")
      setCommDesc(community.description || "")
      setCommCategory(community.category || "")
      setCommCity(community.city || "")
      setCommState(community.state || "")
      setCommCountry(community.country || "")
      setCommEmail(community.contact_email || "")
      setCommPhone(community.contact_phone || "")
      setCommVisibility(community.visibility || "public")
    }
  }, [community])

  useEffect(() => {
    if (success || error) {
      const t = setTimeout(clearMessages, 3000)
      return () => clearTimeout(t)
    }
  }, [success, error, clearMessages])

  const handleSave = async () => {
    await updateProfile({
      first_name: firstName.trim() || null,
      last_name: lastName.trim() || null,
      username: username.trim() || null,
    })
    setEditing(false)
  }

  const handleCancel = () => {
    if (profile) {
      setFirstName(profile.first_name || "")
      setLastName(profile.last_name || "")
      setUsername(profile.username || "")
    }
    setEditing(false)
  }

  const handleCommunitySave = async () => {
    await updateCommunity({
      name: commName.trim(),
      description: commDesc.trim() || null,
      category: commCategory.trim() || null,
      city: commCity.trim() || null,
      state: commState.trim() || null,
      country: commCountry.trim() || null,
      contact_email: commEmail.trim() || null,
      contact_phone: commPhone.trim() || null,
      visibility: commVisibility,
    })
    setCommunityEditing(false)
  }

  const handleCommunityCancel = () => {
    if (community) {
      setCommName(community.name || "")
      setCommDesc(community.description || "")
      setCommCategory(community.category || "")
      setCommCity(community.city || "")
      setCommState(community.state || "")
      setCommCountry(community.country || "")
      setCommEmail(community.contact_email || "")
      setCommPhone(community.contact_phone || "")
      setCommVisibility(community.visibility || "public")
    }
    setCommunityEditing(false)
  }

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const url = await uploadToCloudinary(file)
      await updateProfile({ avatar_url: url })
    } catch {
      // upload failed
    } finally {
      setUploading(false)
      e.target.value = ""
    }
  }

  const handleBannerChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingBanner(true)
    try {
      const url = await uploadToCloudinary(file)
      await updateBanner(url)
    } catch {
      // upload failed
    } finally {
      setUploadingBanner(false)
      e.target.value = ""
    }
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <svg className="h-6 w-6 animate-spin text-[#C2185B]" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl">
      {/* Cover / Banner — click to upload */}
      <input
        ref={bannerInputRef}
        type="file"
        accept="image/*"
        onChange={handleBannerChange}
        className="hidden"
      />
      <button
        onClick={() => bannerInputRef.current?.click()}
        disabled={uploadingBanner}
        className="group relative h-40 w-full overflow-hidden rounded-xl bg-gradient-to-r from-[#C2185B]/20 to-[#C2185B]/5 transition hover:opacity-90 disabled:opacity-50"
      >
        {community?.banner_url ? (
          <img src={community.banner_url} alt="" className="h-full w-full object-cover" />
        ) : null}
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/20">
          {uploadingBanner ? (
            <svg className="h-6 w-6 animate-spin text-white" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="h-6 w-6 text-white opacity-0 transition group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          )}
        </div>
      </button>

      {/* Avatar */}
      <div className="relative -mt-12 ml-8 flex items-end gap-4">
        <div className="relative">
          <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-white bg-[#C2185B]/20 text-3xl font-bold text-[#C2185B] shadow-md">
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="h-full w-full rounded-full object-cover" />
            ) : (
              user?.email?.charAt(0).toUpperCase() || "U"
            )}
          </div>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            onChange={handleAvatarChange}
            className="hidden"
          />
          <button
            onClick={() => avatarInputRef.current?.click()}
            disabled={uploading}
            className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-white text-neutral-500 shadow hover:text-[#C2185B] disabled:opacity-50"
            title="Change avatar"
          >
            {uploading ? (
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            )}
          </button>
        </div>
        <div className="pb-1">
          <h3 className="text-lg font-semibold text-neutral-900">
            {profile?.first_name || profile?.last_name
              ? `${profile.first_name || ""} ${profile.last_name || ""}`.trim()
              : "User"}
          </h3>
          <p className="text-xs text-neutral-400">@{profile?.username || "username"}</p>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="mx-8 mt-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">{error}</div>
      )}
      {success && (
        <div className="mx-8 mt-4 rounded-lg bg-green-50 px-4 py-2 text-sm text-green-600">{success}</div>
      )}

      {/* Profile Info */}
      <div className="mt-6 rounded-xl border border-neutral-200 bg-white px-8 py-6 shadow-soft">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-neutral-700">Profile Information</h4>
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[#C2185B] hover:bg-[#C2185B]/5"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Edit
            </button>
          )}
        </div>

        <div className="mt-5 space-y-4">
          {editing ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-neutral-500">First name</label>
                  <input
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="First name"
                    className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-neutral-500">Last name</label>
                  <input
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Last name"
                    className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-500">Username</label>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="username"
                  className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                />
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="rounded-lg bg-[#C2185B] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save changes"}
                </button>
                <button
                  onClick={handleCancel}
                  className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <Field label="First name" value={profile?.first_name} />
              <Field label="Last name" value={profile?.last_name} />
              <Field label="Username" value={profile?.username ? `@${profile.username}` : null} />
              <Field label="Email" value={user?.email} />
              <Field label="Member since" value={profile?.created_at ? formatDate(profile.created_at) : null} />
            </>
          )}
        </div>
      </div>

      {/* Community Information */}
      {community && (
        <div className="mt-6 rounded-xl border border-neutral-200 bg-white px-8 py-6 shadow-soft">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-neutral-700">Community Information</h4>
            {!communityEditing && (
              <button
                onClick={() => setCommunityEditing(true)}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[#C2185B] hover:bg-[#C2185B]/5"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit
              </button>
            )}
          </div>

          <div className="mt-5 space-y-4">
            {communityEditing ? (
              <>
                <div>
                  <label className="mb-1 block text-xs font-medium text-neutral-500">Community name *</label>
                  <input
                    value={commName}
                    onChange={(e) => setCommName(e.target.value)}
                    placeholder="Community name"
                    className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-neutral-500">Description</label>
                  <textarea
                    value={commDesc}
                    onChange={(e) => setCommDesc(e.target.value)}
                    placeholder="Describe your community..." rows={3}
                    className="w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-500">Category</label>
                    <input
                      value={commCategory}
                      onChange={(e) => setCommCategory(e.target.value)}
                      placeholder="e.g. Arts, Tech, Sports"
                      className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-500">Visibility</label>
                    <div className="flex gap-2 pt-1">
                      {(["public", "private"] as const).map((v) => (
                        <button key={v} type="button" onClick={() => setCommVisibility(v)}
                          className={`rounded-lg px-4 py-1.5 text-xs font-medium transition ${
                            commVisibility === v ? "bg-[#C2185B] text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                          }`}
                        >
                          {v.charAt(0).toUpperCase() + v.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-500">City</label>
                    <input value={commCity} onChange={(e) => setCommCity(e.target.value)}
                      placeholder="City"
                      className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-500">State</label>
                    <input value={commState} onChange={(e) => setCommState(e.target.value)}
                      placeholder="State"
                      className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-500">Country</label>
                    <input value={commCountry} onChange={(e) => setCommCountry(e.target.value)}
                      placeholder="Country"
                      className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-500">Contact email</label>
                    <input type="email" value={commEmail} onChange={(e) => setCommEmail(e.target.value)}
                      placeholder="contact@example.com"
                      className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-500">Contact phone</label>
                    <input type="tel" value={commPhone} onChange={(e) => setCommPhone(e.target.value)}
                      placeholder="+91 9876543210"
                      className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
                    />
                  </div>
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={handleCommunitySave}
                    disabled={saving}
                    className="rounded-lg bg-[#C2185B] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50"
                  >
                    {saving ? "Saving..." : "Save changes"}
                  </button>
                  <button
                    onClick={handleCommunityCancel}
                    className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50"
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <Field label="Name" value={community.name} />
                <Field label="Description" value={community.description} />
                <Field label="Category" value={community.category} />
                <Field label="City" value={community.city} />
                <Field label="State" value={community.state} />
                <Field label="Country" value={community.country} />
                <Field label="Contact email" value={community.contact_email} />
                <Field label="Contact phone" value={community.contact_phone} />
                <Field label="Visibility" value={community.visibility} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs font-medium text-neutral-500">{label}</p>
      <p className="mt-0.5 text-sm text-neutral-900">
        {value || <span className="italic text-neutral-400">Not set</span>}
      </p>
    </div>
  )
}
