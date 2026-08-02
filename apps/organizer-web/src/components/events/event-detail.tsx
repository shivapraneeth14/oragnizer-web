import { useState, useEffect } from "react"
import { supabase } from "../../supabase"
import { copyText } from "../../lib/clipboard"
import { shareBase, isMobileDevice } from "../../lib/share"
import type { Event, Profile, Payment } from "shared"

interface RegistrationWithDetails {
  id: string
  user_id: string
  status: "pending" | "confirmed" | "cancelled" | "attended"
  registered_at: string
  profiles: Pick<Profile, "email" | "first_name" | "last_name">
  payments: Pick<Payment, "amount" | "status">[] | null
}

interface MessageWithProfile {
  id: string
  event_id: string
  user_id: string
  content: string
  created_at: string
  updated_at: string
  profiles: Pick<Profile, "first_name" | "last_name" | "avatar_url"> | null
}

interface RestrictedUserWithProfile {
  id: string
  user_id: string
  created_at: string
  profiles: Pick<Profile, "first_name" | "last_name" | "email"> | null
}

interface Props {
  event: Event
  onEdit: () => void
  onCancel: () => void
  onClose: () => void
}

const statusColors: Record<string, string> = {
  draft: "bg-neutral-100 text-neutral-600",
  published: "bg-green-100 text-green-700",
  cancelled: "bg-red-100 text-red-600",
  completed: "bg-blue-100 text-blue-600",
}

const regStatusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  confirmed: "bg-green-100 text-green-700",
  cancelled: "bg-red-100 text-red-600",
  attended: "bg-blue-100 text-blue-600",
}

const payStatusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  success: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-600",
  refunded: "bg-neutral-100 text-neutral-600",
}

function formatDateTime(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  })
}

function formatPrice(paise: number) {
  if (paise === 0) return "Free"
  return `₹${(paise / 100).toLocaleString("en-IN")}`
}

function formatTimeAgo(dateStr: string) {
  const now = Date.now()
  const diff = now - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "Just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export default function EventDetail({ event, onEdit, onCancel, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<"registrations" | "discussion">("registrations")
  const [registrations, setRegistrations] = useState<RegistrationWithDetails[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [messages, setMessages] = useState<MessageWithProfile[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState("")
  const [menuForId, setMenuForId] = useState<string | null>(null)
  const [restrictedUsers, setRestrictedUsers] = useState<RestrictedUserWithProfile[]>([])
  const [restrictUserId, setRestrictUserId] = useState("")
  const [restrictSearch, setRestrictSearch] = useState("")
  const [searchResults, setSearchResults] = useState<Pick<Profile, "id" | "first_name" | "last_name" | "email">[]>([])
  const [searching, setSearching] = useState(false)
  const [newMessage, setNewMessage] = useState("")
  const [sending, setSending] = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [descTabIndex, setDescTabIndex] = useState(0)
  const [showCancelModal, setShowCancelModal] = useState(false)
  const [cancelConfirmText, setCancelConfirmText] = useState("")
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [showShareOptions, setShowShareOptions] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)

  useEffect(() => { setDescTabIndex(0) }, [event.id])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setCurrentUserId(session.user.id)
    })
  }, [])

  useEffect(() => {
    setLoading(true)
    supabase
      .from("registrations")
      .select("id, user_id, status, registered_at, profiles(email, first_name, last_name), payments(amount, status)")
      .eq("event_id", event.id)
      .is("deleted_at", null)
      .order("registered_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) {
          setError(error.message)
        } else {
          setRegistrations(data as unknown as RegistrationWithDetails[])
        }
        setLoading(false)
      })
  }, [event.id])

  useEffect(() => {
    if (activeTab !== "discussion") return
    loadDiscussion()
    loadRestrictedUsers()
  }, [activeTab, event.id])

  async function loadDiscussion() {
    setMessagesLoading(true)
    setMessagesError(null)
    try {
      const { data, error } = await supabase
        .from("event_messages")
        .select("id, event_id, user_id, content, created_at, updated_at, profiles:user_id(first_name, last_name, avatar_url)")
        .eq("event_id", event.id)
        .order("created_at", { ascending: true })
      if (error) {
        setMessagesError(error.message)
      } else {
        setMessages(data as unknown as MessageWithProfile[])
      }
    } catch (err) {
      setMessagesError((err as Error).message)
    }
    setMessagesLoading(false)
  }

  async function loadRestrictedUsers() {
    try {
      const { data } = await supabase
        .from("event_restricted_users")
        .select("id, user_id, created_at, profiles:user_id(first_name, last_name, email)")
        .eq("event_id", event.id)
      setRestrictedUsers(data as unknown as RestrictedUserWithProfile[])
    } catch (_) {}
  }

  async function deleteMessage(id: string) {
    try {
      await supabase.from("event_messages").delete().eq("id", id)
      setMessages((prev) => prev.filter((m) => m.id !== id))
    } catch (e) {
      console.error("deleteMessage error", e)
    }
  }

  async function saveEdit(id: string) {
    try {
      if (!editText.trim()) return
      await supabase.from("event_messages").update({ content: editText.trim() }).eq("id", id)
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, content: editText.trim(), updated_at: new Date().toISOString() } : m))
      )
      setEditingId(null)
      setEditText("")
    } catch (e) {
      console.error("saveEdit error", e)
    }
  }

  async function restrictUser(userId: string) {
    if (!currentUserId) return
    try {
      await supabase.from("event_restricted_users").insert({
        event_id: event.id,
        user_id: userId,
        created_by: currentUserId,
      })
      setRestrictUserId("")
      setRestrictSearch("")
      setSearchResults([])
      loadRestrictedUsers()
    } catch (e) {
      console.error("restrictUser error", e)
    }
  }

  async function unrestrictUserByUserId(userId: string) {
    const row = restrictedUsers.find((r) => r.user_id === userId)
    if (row) await unrestrictUser(row.id)
  }

  async function unrestrictUser(id: string) {
    try {
      await supabase.from("event_restricted_users").delete().eq("id", id)
      loadRestrictedUsers()
    } catch (e) {
      console.error("unrestrictUser error", e)
    }
  }

  async function handleCancelEvent() {
    setCancelling(true)
    setCancelError(null)
    try {
      const { data, error } = await supabase.functions.invoke("cancel-event", {
        body: { event_id: event.id },
      })
      if (error) {
        setCancelError(error.message)
      } else if (data?.error) {
        setCancelError(data.error)
      } else {
        setShowCancelModal(false)
        setCancelConfirmText("")
        onCancel()
      }
    } catch (e) {
      setCancelError((e as Error).message)
    }
    setCancelling(false)
  }

  async function sendMessage() {
    const text = newMessage.trim()
    if (!text) return
    setSending(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setSending(false); return }
      const { error } = await supabase.from("event_messages").insert({
        event_id: event.id,
        user_id: session.user.id,
        content: text,
      })
      if (!error) {
        setNewMessage("")
        loadDiscussion()
      }
    } catch (e) {
      console.error("sendMessage error", e)
    }
    setSending(false)
  }

  async function searchUsers(query: string) {
    setRestrictSearch(query)
    if (query.length < 2) {
      setSearchResults([])
      return
    }
    setSearching(true)
    const { data } = await supabase
      .from("community_members")
      .select("profiles:user_id(id, first_name, last_name, email)")
      .eq("community_id", event.community_id)
      .or(`profiles.first_name.ilike.%${query}%,profiles.last_name.ilike.%${query}%,profiles.email.ilike.%${query}%`)
      .limit(10)
    const members = (data || []) as unknown as {
      profiles: Pick<Profile, "id" | "first_name" | "last_name" | "email"> | null
    }[]
    const restrictedIds = new Set(restrictedUsers.map((r) => r.user_id))
    setSearchResults(
      members
        .map((m) => m.profiles)
        .filter((p): p is Pick<Profile, "id" | "first_name" | "last_name" | "email"> =>
          !!p && !restrictedIds.has(p.id)
        )
    )
    setSearching(false)
  }

  const restrictedUserIds = new Set(restrictedUsers.map((r) => r.user_id))

  return (
    <div>
      <button
        onClick={onClose}
        className="mb-4 flex items-center gap-1.5 text-sm font-medium text-[#C2185B] hover:text-[#A0154A]"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 12H5m7-7l-7 7 7 7" />
        </svg>
        Back to Events
      </button>

      <div className="mx-auto max-w-3xl">
        {event.image_url && (
          <div className="overflow-hidden rounded-xl">
            <img src={event.image_url} alt="" className="h-56 w-full object-cover" />
          </div>
        )}

        <div className="mt-6 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-neutral-900">{event.title}</h2>
              {event.description && (() => {
                const sections = event.description!.split(/\n(?=## )/)
                const parsed = sections.map(s => {
                  const match = s.match(/^## (.+?)\n([\s\S]*)$/)
                  return match ? { title: match[1], content: match[2] } : null
                }).filter(Boolean) as { title: string; content: string }[]
                if (parsed.length === 0) {
                  return <p className="mt-2 text-sm text-neutral-600">{event.description}</p>
                }
                if (parsed.length === 1) {
                  return (
                    <div className="mt-2">
                      <h4 className="text-sm font-semibold text-neutral-800">{parsed[0].title}</h4>
                      <p className="mt-1 text-sm text-neutral-600 whitespace-pre-line">{parsed[0].content}</p>
                    </div>
                  )
                }
                const section = parsed[descTabIndex] ?? parsed[0]
                return (
                  <div className="mt-2">
                    <div className="flex gap-4 border-b border-neutral-200 mb-3">
                      {parsed.map((s, i) => (
                        <button
                          key={s.title}
                          onClick={() => setDescTabIndex(i)}
                          className={`pb-1 text-xs font-medium border-b-2 transition-colors ${
                            descTabIndex === i
                              ? "border-blue-600 text-blue-600"
                              : "border-transparent text-neutral-400 hover:text-neutral-600"
                          }`}
                        >
                          {s.title}
                        </button>
                      ))}
                    </div>
                    <p className="text-sm text-neutral-600 whitespace-pre-line">{section.content}</p>
                  </div>
                )
              })()}
            </div>
            <div className="flex items-center gap-2">
              {event.status !== "cancelled" && event.status !== "completed" && (
                <>
                  <button
                    onClick={onEdit}
                    className="flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    Edit
                  </button>
                  <button
                    onClick={() => setShowCancelModal(true)}
                    className="flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 transition-colors"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    Cancel
                  </button>
                </>
              )}
              <div className="relative">
                <button
                  onClick={async () => {
                    const url = `${shareBase()}events/${event.id}`;
                    if (navigator.share && isMobileDevice()) {
                      try {
                        await navigator.share({ title: `Check out ${event.title} on Cluvo`, url });
                      } catch {
                        // user cancelled — do nothing
                      }
                    } else {
                      setShowShareOptions(!showShareOptions);
                    }
                  }}
                  className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    shareCopied
                      ? "border-green-600 bg-green-600 text-white"
                      : "border-neutral-300 text-neutral-600 hover:bg-neutral-50"
                  }`}
                >
                  {shareCopied ? (
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                    </svg>
                  )}
                  {shareCopied ? 'Copied!' : 'Share'}
                </button>

                {showShareOptions && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowShareOptions(false)} />
                    <div className="absolute right-0 top-full z-50 mt-2 w-48 rounded-xl border border-neutral-200 bg-white shadow-lg">
                      <div className="p-1.5">
                        <button
                          onClick={() => {
                            const url = encodeURIComponent(`${shareBase()}events/${event.id}`);
                            const text = encodeURIComponent(`Check out ${event.title} on Cluvo!\n${url}`);
                            window.open(`https://wa.me/?text=${text}`, '_blank');
                            setShowShareOptions(false);
                          }}
                          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-neutral-700 hover:bg-neutral-100"
                        >
                          <svg className="h-5 w-5 text-green-500" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                          WhatsApp
                        </button>
                        <button
                          onClick={() => {
                            const url = encodeURIComponent(`${shareBase()}events/${event.id}`);
                            window.location.href = `mailto:?subject=${encodeURIComponent(`Check out ${event.title} on Cluvo`)}&body=${url}`;
                            setShowShareOptions(false);
                          }}
                          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-neutral-700 hover:bg-neutral-100"
                        >
                          <svg className="h-5 w-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                          </svg>
                          Email
                        </button>
                        <button
                          onClick={async () => {
                            await copyText(`${shareBase()}events/${event.id}`);
                            setShareCopied(true);
                            setShowShareOptions(false);
                            setTimeout(() => setShareCopied(false), 2000);
                          }}
                          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-neutral-700 hover:bg-neutral-100"
                        >
                          <svg className="h-5 w-5 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                          Copy Link
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${statusColors[event.status]}`}>
                {event.status.charAt(0).toUpperCase() + event.status.slice(1)}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-8 gap-y-4 rounded-xl border border-neutral-200 bg-white p-6">
            <DetailItem label="Start" value={formatDateTime(event.start_date)} />
            {event.end_date ? <DetailItem label="End" value={formatDateTime(event.end_date)} /> : null}
            {event.location ? <DetailItem label="Location" value={event.location} /> : null}
            {event.capacity ? (
              <DetailItem label="Capacity" value={`${event.booked_count || 0} / ${event.capacity}`} />
            ) : null}
            <DetailItem label="Price" value={formatPrice(event.price)} />
          </div>

          {/* Tab bar */}
          <div className="flex gap-6 border-b border-neutral-200">
            <button
              onClick={() => setActiveTab("registrations")}
              className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "registrations"
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-neutral-500 hover:text-neutral-700"
              }`}
            >
              Registrations {!loading && `(${registrations.length})`}
            </button>
            <button
              onClick={() => setActiveTab("discussion")}
              className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "discussion"
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-neutral-500 hover:text-neutral-700"
              }`}
            >
              Discussion {!messagesLoading && `(${messages.length})`}
            </button>
          </div>

          {/* Registrations tab */}
          {activeTab === "registrations" && (
            <div>
              {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
              {loading ? (
                <div className="flex justify-center py-10">
                  <svg className="h-5 w-5 animate-spin text-[#C2185B]" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              ) : registrations.length === 0 ? (
                <div className="rounded-xl border border-neutral-200 py-10 text-center">
                  <svg className="mx-auto h-8 w-8 text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  <p className="mt-2 text-sm text-neutral-400">No registrations yet.</p>
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-neutral-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium text-neutral-500">
                        <th className="px-4 py-3">Name</th>
                        <th className="px-4 py-3">Email</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Payment</th>
                        <th className="px-4 py-3">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {registrations.map((reg) => (
                        <tr key={reg.id} className="hover:bg-neutral-50">
                          <td className="px-4 py-3 text-neutral-900">
                            {[reg.profiles?.first_name, reg.profiles?.last_name].filter(Boolean).join(" ") || "—"}
                          </td>
                          <td className="px-4 py-3 text-neutral-500">{reg.profiles?.email || "—"}</td>
                          <td className="px-4 py-3">
                            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${regStatusColors[reg.status]}`}>
                              {reg.status.charAt(0).toUpperCase() + reg.status.slice(1)}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {reg.payments && reg.payments.length > 0 ? (
                              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${payStatusColors[reg.payments[0].status]}`}>
                                {reg.payments[0].status.charAt(0).toUpperCase() + reg.payments[0].status.slice(1)}
                              </span>
                            ) : (
                              <span className="text-xs text-neutral-400">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-neutral-500">
                            {new Date(reg.registered_at).toLocaleDateString("en-US", {
                              month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                            })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Discussion tab */}
          {activeTab === "discussion" && (
            <div className="space-y-4">
              {/* Messages */}
              {event.discussion_enabled && (
                <div className="rounded-xl border border-neutral-200 bg-white">
                  <div className="px-4 py-3 border-b border-neutral-100">
                    <h4 className="text-sm font-semibold text-neutral-700">Messages</h4>
                  </div>

                  {messagesError && (
                    <p className="p-4 text-sm text-red-500">{messagesError}</p>
                  )}

                  {messagesLoading ? (
                    <div className="flex justify-center py-10">
                      <svg className="h-5 w-5 animate-spin text-[#C2185B]" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="py-10 text-center">
                      <svg className="mx-auto h-8 w-8 text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                      </svg>
                      <p className="mt-2 text-sm text-neutral-400">No messages yet.</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-neutral-100 max-h-96 overflow-y-auto">
                      {messages.map((msg) => (
                        <div key={msg.id} className="px-4 py-3 hover:bg-neutral-50 group">
                          {editingId === msg.id ? (
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                className="flex-1 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                                autoFocus
                              />
                              <button
                                onClick={() => saveEdit(msg.id)}
                                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => { setEditingId(null); setEditText("") }}
                                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-start gap-3">
                              <div className="h-8 w-8 shrink-0 rounded-full bg-[#C2185B]/10 flex items-center justify-center text-xs font-bold text-[#C2185B]">
                                {(msg.profiles?.first_name?.[0] || msg.profiles?.last_name?.[0] || "U").toUpperCase()}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium text-neutral-900">
                                    {[msg.profiles?.first_name, msg.profiles?.last_name].filter(Boolean).join(" ") || "Unknown"}
                                  </span>
                                  <span className="text-xs text-neutral-400">{formatTimeAgo(msg.created_at)}</span>
                                  {msg.created_at !== msg.updated_at && (
                                    <span className="text-xs text-neutral-400 italic">(edited)</span>
                                  )}
                                </div>
                                <p className="mt-0.5 text-sm text-neutral-700">{msg.content}</p>
                              </div>
                              {msg.user_id === currentUserId && (
                                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                  <button
                                    onClick={() => { setEditingId(msg.id); setEditText(msg.content) }}
                                    className="rounded p-1 text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100"
                                    title="Edit"
                                  >
                                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                    </svg>
                                  </button>
                                  <button
                                    onClick={() => deleteMessage(msg.id)}
                                    className="rounded p-1 text-neutral-400 hover:text-red-600 hover:bg-red-50"
                                    title="Delete"
                                  >
                                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                  </button>
                                </div>
                              )}
                              {msg.user_id !== currentUserId && (
                                <div className="relative shrink-0">
                                  <button
                                    onClick={() => setMenuForId(menuForId === msg.id ? null : msg.id)}
                                    className="rounded p-1 text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-neutral-600 hover:bg-neutral-100 transition-opacity"
                                    title="More"
                                  >
                                    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                                      <path d="M6 10a2 2 0 100 4 2 2 0 000-4zm6 0a2 2 0 100 4 2 2 0 000-4zm6 0a2 2 0 100 4 2 2 0 000-4z" />
                                    </svg>
                                  </button>
                                  {menuForId === msg.id && (
                                    <>
                                      <div className="fixed inset-0 z-10" onClick={() => setMenuForId(null)} />
                                      <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-neutral-200 bg-white py-1 shadow-medium">
                                        {restrictedUserIds.has(msg.user_id) ? (
                                          <button
                                            onClick={() => { setMenuForId(null); unrestrictUserByUserId(msg.user_id) }}
                                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-50"
                                          >
                                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                              <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                                            </svg>
                                            Unrestrict
                                          </button>
                                        ) : (
                                          <button
                                            onClick={() => { setMenuForId(null); restrictUser(msg.user_id) }}
                                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                                          >
                                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                                            </svg>
                                            Restrict user
                                          </button>
                                        )}
                                      </div>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Send message */}
              {event.discussion_enabled && (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
                    placeholder="Type a message..."
                    className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]"
                  />
                  <button
                    onClick={sendMessage}
                    disabled={sending || !newMessage.trim()}
                    className="rounded-lg bg-[#C2185B] px-4 py-2 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {sending ? "Sending..." : "Send"}
                  </button>
                </div>
              )}

              {/* Restricted users */}
              {event.discussion_enabled && (
                <div className="rounded-xl border border-neutral-200 bg-white p-4 space-y-3">
                  <h4 className="text-sm font-semibold text-neutral-700">Restricted Users</h4>

                  {restrictedUsers.length > 0 && (
                    <div className="space-y-2 mb-3">
                      {restrictedUsers.map((ru) => (
                        <div key={ru.id} className="flex items-center justify-between py-1.5 px-3 bg-neutral-50 rounded-lg">
                          <span className="text-sm text-neutral-700">
                            {[ru.profiles?.first_name, ru.profiles?.last_name].filter(Boolean).join(" ") || ru.profiles?.email || ru.user_id}
                          </span>
                          <button
                            onClick={() => unrestrictUser(ru.id)}
                            className="text-xs font-medium text-blue-600 hover:text-blue-800"
                          >
                            Unrestrict
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="relative">
                    <input
                      type="text"
                      placeholder="Search user by name or email..."
                      value={restrictSearch}
                      onChange={(e) => searchUsers(e.target.value)}
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    />
                    {searching && (
                      <div className="absolute right-3 top-2.5">
                        <svg className="h-4 w-4 animate-spin text-neutral-400" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      </div>
                    )}
                    {searchResults.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full rounded-lg border border-neutral-200 bg-white shadow-lg">
                        {searchResults.map((u) => (
                          <button
                            key={u.id}
                            onClick={() => {
                              restrictUser(u.id)
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
                          >
                            <span>{[u.first_name, u.last_name].filter(Boolean).join(" ") || u.email}</span>
                            <span className="text-xs text-neutral-400">{u.email}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {!event.discussion_enabled && (
                <div className="rounded-xl border border-neutral-200 bg-neutral-50 py-10 text-center">
                  <svg className="mx-auto h-8 w-8 text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <p className="mt-2 text-sm text-neutral-400">Discussion is disabled. Enable it in event settings.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showCancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-neutral-900">Cancel Event</h3>
            <p className="mt-2 text-sm text-neutral-600">
              This will cancel the event, refund all paid registrations, and notify attendees.
              Type <span className="font-bold text-red-600">END EVENT</span> to confirm.
            </p>
            <input
              type="text"
              value={cancelConfirmText}
              onChange={(e) => setCancelConfirmText(e.target.value)}
              placeholder="Type END EVENT"
              className="mt-4 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400"
            />
            {cancelError && (
              <p className="mt-2 text-sm text-red-500">{cancelError}</p>
            )}
            <div className="mt-4 flex gap-3">
              <button
                onClick={() => {
                  setShowCancelModal(false)
                  setCancelConfirmText("")
                  setCancelError(null)
                }}
                className="flex-1 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
                disabled={cancelling}
              >
                Keep Event
              </button>
              <button
                onClick={handleCancelEvent}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                disabled={cancelConfirmText !== "END EVENT" || cancelling}
              >
                {cancelling ? "Cancelling..." : "Confirm Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-neutral-500">{label}</p>
      <p className="mt-0.5 text-sm text-neutral-900">{value}</p>
    </div>
  )
}
