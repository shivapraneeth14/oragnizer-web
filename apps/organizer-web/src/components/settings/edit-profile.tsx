import { useState, useEffect, useRef } from "react"
import { useAuth } from "../../auth-context"
import { useProfile } from "../../hooks/use-profile"
import { uploadToCloudinary } from "../../lib/cloudinary"

export default function EditProfile() {
  const { user } = useAuth()
  const { profile, community, saving, error, success, updateProfile, updateBanner, updateCommunity, clearMessages } = useProfile()

  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [username, setUsername] = useState("")
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null)
  const [checkingUsername, setCheckingUsername] = useState(false)
  const [commName, setCommName] = useState("")
  const [commNameAvailable, setCommNameAvailable] = useState<boolean | null>(null)
  const [checkingCommName, setCheckingCommName] = useState(false)
  const [commDesc, setCommDesc] = useState("")
  const [commCategory, setCommCategory] = useState("")
  const [commCity, setCommCity] = useState("")
  const [commState, setCommState] = useState("")
  const [commCountry, setCommCountry] = useState("")
  const [commEmail, setCommEmail] = useState("")
  const [commEmailAvailable, setCommEmailAvailable] = useState<boolean | null>(null)
  const [checkingCommEmail, setCheckingCommEmail] = useState(false)
  const [commPhone, setCommPhone] = useState("")

  const [uploading, setUploading] = useState(false)
  const [uploadingBanner, setUploadingBanner] = useState(false)
  const avatarRef = useRef<HTMLInputElement>(null)
  const bannerRef = useRef<HTMLInputElement>(null)
  const usernameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commNameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commEmailTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    }
  }, [community])

  useEffect(() => {
    if (usernameTimer.current) clearTimeout(usernameTimer.current)
    const u = username.trim()
    if (u.length < 1) { setUsernameAvailable(null); setCheckingUsername(false); return }
    if (u === profile?.username) { setUsernameAvailable(null); setCheckingUsername(false); return }
    setCheckingUsername(true)
    usernameTimer.current = setTimeout(async () => {
      const { supabaseFetchNoAuth } = await import("../../supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/check-username", { username: u, current_user_id: profile?.id })
      const d = await res.json()
      setUsernameAvailable(d.available === true)
      setCheckingUsername(false)
    }, 500)
    return () => { if (usernameTimer.current) clearTimeout(usernameTimer.current) }
  }, [username, profile?.id, profile?.username])

  useEffect(() => {
    if (commNameTimer.current) clearTimeout(commNameTimer.current)
    const n = commName.trim()
    if (n.length < 1) { setCommNameAvailable(null); setCheckingCommName(false); return }
    if (n === community?.name) { setCommNameAvailable(null); setCheckingCommName(false); return }
    setCheckingCommName(true)
    commNameTimer.current = setTimeout(async () => {
      const { supabaseFetchNoAuth } = await import("../../supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/check-community-name", { name: n, community_id: community?.id })
      const d = await res.json()
      setCommNameAvailable(d.available === true)
      setCheckingCommName(false)
    }, 500)
    return () => { if (commNameTimer.current) clearTimeout(commNameTimer.current) }
  }, [commName, community?.id, community?.name])

  useEffect(() => {
    if (commEmailTimer.current) clearTimeout(commEmailTimer.current)
    const e = commEmail.trim()
    if (e.length < 1) { setCommEmailAvailable(null); setCheckingCommEmail(false); return }
    if (e === community?.contact_email) { setCommEmailAvailable(null); setCheckingCommEmail(false); return }
    setCheckingCommEmail(true)
    commEmailTimer.current = setTimeout(async () => {
      const { supabaseFetchNoAuth } = await import("../../supabase-fetch")
      const res = await supabaseFetchNoAuth("/functions/v1/check-community-email", { email: e, community_id: community?.id })
      const d = await res.json()
      setCommEmailAvailable(d.available === true)
      setCheckingCommEmail(false)
    }, 500)
    return () => { if (commEmailTimer.current) clearTimeout(commEmailTimer.current) }
  }, [commEmail, community?.id, community?.contact_email])

  useEffect(() => {
    if (success || error) {
      const t = setTimeout(clearMessages, 3000)
      return () => clearTimeout(t)
    }
  }, [success, error, clearMessages])

  const handleAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const url = await uploadToCloudinary(file)
      await updateProfile({ avatar_url: url })
    } catch {
      /* ignore */
    }
    setUploading(false)
    e.target.value = ""
  }

  const handleBanner = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingBanner(true)
    try {
      const url = await uploadToCloudinary(file)
      await updateBanner(url)
    } catch {
      /* ignore */
    }
    setUploadingBanner(false)
    e.target.value = ""
  }

  const handleSave = async () => {
    await updateProfile({
      first_name: firstName.trim() || null,
      last_name: lastName.trim() || null,
      username: username.trim() || null,
    })
    if (community) {
      await updateCommunity({
        name: commName.trim(),
        description: commDesc.trim() || null,
        category: commCategory.trim() || null,
        city: commCity.trim() || null,
        state: commState.trim() || null,
        country: commCountry.trim() || null,
        contact_email: commEmail.trim() || null,
        contact_phone: commPhone.trim() || null,
      })
    }
  }

  return (
    <div>
      <h3 className="text-xl font-semibold text-neutral-900">Edit Profile</h3>
      <p className="mt-1 text-sm text-neutral-500">Update your personal info and community details.</p>

      {error && (
        <div className="mt-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">{error}</div>
      )}
      {success && (
        <div className="mt-4 rounded-lg bg-green-50 px-4 py-2 text-sm text-green-600">{success}</div>
      )}

      {/* Banner + Avatar */}
      <div className="mt-6">
        <input ref={bannerRef} type="file" accept="image/*" onChange={handleBanner} className="hidden" />
        <input ref={avatarRef} type="file" accept="image/*" onChange={handleAvatar} className="hidden" />

        <button
          onClick={() => bannerRef.current?.click()}
          disabled={uploadingBanner}
          className="group relative h-36 w-full overflow-hidden rounded-xl bg-gradient-to-r from-[#C2185B]/20 to-[#C2185B]/5 transition hover:opacity-90 disabled:opacity-50"
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

        <div className="relative -mt-10 ml-6 flex items-end gap-4">
          <button
            onClick={() => avatarRef.current?.click()}
            disabled={uploading}
            className="group relative flex h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-[#C2185B]/20 text-2xl font-bold text-[#C2185B] shadow-md transition hover:opacity-90 disabled:opacity-50"
          >
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="h-full w-full rounded-full object-cover" />
            ) : (
              user?.email?.charAt(0).toUpperCase() || "U"
            )}
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 transition group-hover:bg-black/20">
              {uploading ? (
                <svg className="h-5 w-5 animate-spin text-white" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="h-5 w-5 text-white opacity-0 transition group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                </svg>
              )}
            </div>
          </button>
        </div>
      </div>

      {/* Personal */}
      <div className="mt-8 rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
        <h4 className="text-sm font-semibold text-neutral-700">Personal</h4>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">First name</label>
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">Last name</label>
            <input value={lastName} onChange={(e) => setLastName(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" />
          </div>
        </div>
        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-neutral-500">Username</label>
          <div className="relative">
            <input value={username} onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 pr-8 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
              {checkingUsername ? (
                <svg className="h-4 w-4 animate-spin text-neutral-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : usernameAvailable === true ? (
                <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : usernameAvailable === false ? (
                <svg className="h-4 w-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : null}
            </span>
          </div>
          {usernameAvailable === false && (
            <p className="mt-0.5 text-xs text-red-500">This username is taken</p>
          )}
        </div>
        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-neutral-500">Email</label>
          <p className="text-sm text-neutral-700">{user?.email || "—"}</p>
        </div>
      </div>

      {/* Community */}
      {community && (
        <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
          <h4 className="text-sm font-semibold text-neutral-700">Community</h4>
          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-neutral-500">Name *</label>
            <div className="relative">
              <input value={commName} onChange={(e) => setCommName(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 pr-8 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2">
                {checkingCommName ? (
                  <svg className="h-4 w-4 animate-spin text-neutral-400" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : commNameAvailable === true ? (
                  <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : commNameAvailable === false ? (
                  <svg className="h-4 w-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : null}
              </span>
            </div>
            {commNameAvailable === false && (
              <p className="mt-0.5 text-xs text-red-500">This name is taken</p>
            )}
          </div>
          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-neutral-500">Description</label>
            <textarea value={commDesc} onChange={(e) => setCommDesc(e.target.value)} rows={3}
              className="w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" />
          </div>
          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-neutral-500">Category</label>
            <input value={commCategory} onChange={(e) => setCommCategory(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">City</label>
              <input value={commCity} onChange={(e) => setCommCity(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">State</label>
              <input value={commState} onChange={(e) => setCommState(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">Country</label>
              <input value={commCountry} onChange={(e) => setCommCountry(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" />
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">Contact email</label>
              <div className="relative">
                <input type="email" value={commEmail} onChange={(e) => setCommEmail(e.target.value)}
                  className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 pr-8 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" />
                <span className="absolute right-3 top-1/2 -translate-y-1/2">
                  {checkingCommEmail ? (
                    <svg className="h-4 w-4 animate-spin text-neutral-400" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : commEmailAvailable === true ? (
                    <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : commEmailAvailable === false ? (
                    <svg className="h-4 w-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  ) : null}
                </span>
              </div>
              {commEmailAvailable === false && (
                <p className="mt-0.5 text-xs text-red-500">This email is already in use by another community</p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">Contact phone</label>
              <input type="tel" value={commPhone} onChange={(e) => setCommPhone(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" />
            </div>
          </div>
        </div>
      )}

      <div className="mt-6">
        <button
          onClick={handleSave}
          disabled={saving || checkingUsername || checkingCommName || checkingCommEmail || usernameAvailable === false || commNameAvailable === false || commEmailAvailable === false}
          className="rounded-lg bg-[#C2185B] px-6 py-2.5 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  )
}
