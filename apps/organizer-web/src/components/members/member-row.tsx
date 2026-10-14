import { useState } from "react"

interface Member {
  user_id: string
  role: string
  joined_at: string
  email: string | null
  username: string | null
  first_name: string | null
  last_name: string | null
}

interface Props {
  member: Member
  currentUserId: string
  communityId: string
  onRemoved: () => void
  card?: boolean
}

export default function MemberRow({ member, currentUserId, communityId, onRemoved, card }: Props) {
  const [removing, setRemoving] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const isOwner = member.role === "OWNER"
  const isSelf = member.user_id === currentUserId

  const handleRemove = async () => {
    setRemoving(true)
    try {
      const token = (await import("../../supabase")).supabase.auth.getSession()
      const accessToken = (await token).data.session?.access_token
      if (!accessToken) return

      const { supabaseFetch } = await import("../../supabase-fetch")
      const res = await supabaseFetch("/functions/v1/remove-member", accessToken,
        { community_id: communityId, user_id: member.user_id })
      const data = await res.json()
      if (!res.ok) {
        alert(data.error || "Failed to remove member")
      } else {
        onRemoved()
      }
    } catch {
      alert("Something went wrong")
    }
    setRemoving(false)
    setConfirm(false)
  }

  const displayName = `@${member.username || member.email?.split("@")[0] || "unknown"}`
  const initial = (member.username || member.email || "?")[0].toUpperCase()
  const joined = new Date(member.joined_at).toLocaleDateString()

  const rolePill = (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
      isOwner ? "bg-cluvo-primary/10 text-cluvo-primary" : "bg-neutral-100 text-neutral-600"
    }`}>
      {member.role}
    </span>
  )

  const removeControl = !isOwner && !isSelf ? (
    confirm ? (
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-red-600">Remove?</span>
        <button
          onClick={handleRemove}
          disabled={removing}
          className="rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
        >
          {removing ? "..." : "Yes"}
        </button>
        <button
          onClick={() => setConfirm(false)}
          className="rounded bg-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-300"
        >
          No
        </button>
      </div>
    ) : (
      <button
        onClick={() => setConfirm(true)}
        className="text-xs font-medium text-red-500 hover:text-red-700 transition-colors"
      >
        Remove
      </button>
    )
  ) : null

  if (card) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cluvo-primary/10 text-xs font-bold text-cluvo-primary">
              {initial}
            </div>
            <span className="truncate font-medium text-neutral-700">{displayName}</span>
          </div>
          {rolePill}
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-neutral-100 pt-2 text-xs">
          <span className="text-neutral-500">Joined {joined}</span>
          {removeControl}
        </div>
      </div>
    )
  }

  return (
    <tr className="border-b border-neutral-100 transition-colors hover:bg-neutral-50">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-cluvo-primary/10 text-xs font-bold text-cluvo-primary">
            {initial}
          </div>
          <span className="font-medium text-neutral-700">{displayName}</span>
        </div>
      </td>
      <td className="px-4 py-3">{rolePill}</td>
      <td className="px-4 py-3 text-neutral-500">{joined}</td>
      <td className="px-4 py-3 text-right">{removeControl}</td>
    </tr>
  )
}
