import { useState, useEffect } from "react"
import { supabase } from "../../supabase"
import type { Event, Profile, Payment } from "shared"

interface RegistrationWithDetails {
  id: string
  user_id: string
  status: "pending" | "confirmed" | "cancelled" | "attended"
  registered_at: string
  profiles: Pick<Profile, "email" | "first_name" | "last_name">
  payments: Pick<Payment, "amount" | "status">[] | null
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

export default function EventDetail({ event, onEdit, onCancel, onClose }: Props) {
  const [registrations, setRegistrations] = useState<RegistrationWithDetails[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div>
      {/* Back button */}
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
        {/* Image */}
        {event.image_url && (
          <div className="overflow-hidden rounded-xl">
            <img src={event.image_url} alt="" className="h-56 w-full object-cover" />
          </div>
        )}

        <div className="mt-6 space-y-6">
          {/* Title + Status */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-neutral-900">{event.title}</h2>
              {event.description && (
                <p className="mt-2 text-sm text-neutral-600">{event.description}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const base = import.meta.env.VITE_APP_DEEPLINK_BASE || 'cluvo://';
                  const url = `${base}events/${event.id}`;
                  navigator.clipboard.writeText(url);
                }}
                className="flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                </svg>
                Share
              </button>
              <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${statusColors[event.status]}`}>
                {event.status.charAt(0).toUpperCase() + event.status.slice(1)}
              </span>
            </div>
          </div>

          {/* Details grid */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 rounded-xl border border-neutral-200 bg-white p-6">
            <DetailItem label="Start" value={formatDateTime(event.start_date)} />
            {event.end_date ? <DetailItem label="End" value={formatDateTime(event.end_date)} /> : null}
            {event.location ? <DetailItem label="Location" value={event.location} /> : null}
            {event.capacity ? (
              <DetailItem label="Capacity" value={`${event.booked_count || 0} / ${event.capacity}`} />
            ) : null}
            <DetailItem label="Price" value={formatPrice(event.price)} />
          </div>

          {/* Actions */}
          {event.status !== "cancelled" && event.status !== "completed" && (
            <div className="flex gap-3">
              <button
                onClick={onEdit}
                className="flex items-center gap-1.5 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit Event
              </button>
              <button
                onClick={onCancel}
                className="flex items-center gap-1.5 rounded-lg bg-red-50 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-100"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Cancel Event
              </button>
            </div>
          )}

          {/* Registrations */}
          <div>
            <h3 className="text-lg font-semibold text-neutral-900">
              Registrations {!loading && `(${registrations.length})`}
            </h3>

            {error && (
              <p className="mt-2 text-sm text-red-500">{error}</p>
            )}

            {loading ? (
              <div className="flex justify-center py-10">
                <svg className="h-5 w-5 animate-spin text-[#C2185B]" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              </div>
            ) : registrations.length === 0 ? (
              <div className="mt-3 rounded-xl border border-neutral-200 py-10 text-center">
                <svg className="mx-auto h-8 w-8 text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <p className="mt-2 text-sm text-neutral-400">No registrations yet.</p>
              </div>
            ) : (
              <div className="mt-3 overflow-hidden rounded-xl border border-neutral-200">
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
        </div>
      </div>
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
