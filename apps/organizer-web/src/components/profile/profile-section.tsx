import { useAuth } from "../../auth-context"
import { useProfile } from "../../hooks/use-profile"

export default function ProfileSection() {
  const { user } = useAuth()
  const { profile, community, loading } = useProfile()

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
      {/* Banner */}
      <div className="relative h-40 w-full overflow-hidden rounded-xl bg-gradient-to-r from-[#C2185B]/20 to-[#C2185B]/5">
        {community?.banner_url ? (
          <img src={community.banner_url} alt="" className="h-full w-full object-cover" />
        ) : null}
      </div>

      {/* Avatar + Name */}
      <div className="relative -mt-12 ml-8 flex items-start gap-4">
        <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-white bg-[#C2185B]/20 text-3xl font-bold text-[#C2185B] shadow-md">
          {community?.community_avatar_url ? (
            <img src={community.community_avatar_url} alt="" className="h-full w-full rounded-full object-cover" />
          ) : (
            community?.name?.charAt(0).toUpperCase() || user?.email?.charAt(0).toUpperCase() || "U"
          )}
        </div>
        <div className="pb-1 mt-10">
          <h3 className="text-lg font-semibold text-neutral-900">
            {profile?.first_name || profile?.last_name
              ? `${profile.first_name || ""} ${profile.last_name || ""}`.trim()
              : "User"}
          </h3>
          <p className="text-xs text-neutral-400">@{profile?.username || "username"}</p>
        </div>
      </div>

      {community && (
        <div className="mt-2 flex justify-end gap-3 pr-8">
          {community.instagram_url && (
            <a href={community.instagram_url} target="_blank" rel="noopener noreferrer" className="text-neutral-600 transition-colors hover:text-neutral-900" title="Instagram">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
            </a>
          )}
          {community.facebook_url && (
            <a href={community.facebook_url} target="_blank" rel="noopener noreferrer" className="text-neutral-600 transition-colors hover:text-neutral-900" title="Facebook">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
            </a>
          )}
          {community.twitter_url && (
            <a href={community.twitter_url} target="_blank" rel="noopener noreferrer" className="text-neutral-600 transition-colors hover:text-neutral-900" title="Twitter / X">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            </a>
          )}
          {community.linkedin_url && (
            <a href={community.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-neutral-600 transition-colors hover:text-neutral-900" title="LinkedIn">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
            </a>
          )}
        </div>
      )}

      {/* Profile Info */}
      <div className="mt-6 rounded-xl border border-neutral-200 bg-white px-8 py-6 shadow-soft">
        <h4 className="text-sm font-semibold text-neutral-700">Profile Information</h4>
        <div className="mt-5 space-y-4">
          <Field label="First name" value={profile?.first_name} />
          <Field label="Last name" value={profile?.last_name} />
          <Field label="Username" value={profile?.username ? `@${profile.username}` : null} />
          <Field label="Email" value={user?.email} />
          <Field label="Member since" value={profile?.created_at ? formatDate(profile.created_at) : null} />
        </div>
      </div>

      {/* Community Information */}
      {community && (
        <div className="mt-6 rounded-xl border border-neutral-200 bg-white px-8 py-6 shadow-soft">
          <h4 className="text-sm font-semibold text-neutral-700">Community Information</h4>
          <div className="mt-5 space-y-4">
            <Field label="Name" value={community.name} />
            <Field label="Description" value={community.description} />
            <Field label="Category" value={community.category} />
            <Field label="City" value={community.city} />
            <Field label="State" value={community.state} />
            <Field label="Country" value={community.country} />
            <Field label="Contact email" value={community.contact_email} />
            <Field label="Contact phone" value={community.contact_phone} />
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
