import { useEffect, useState, useCallback } from "react"
import { useParams, Link } from "react-router-dom"
import { supabase } from "../supabase"
import { fetchAdminProfiles, type AdminProfile } from "../lib/admin-profiles"
import RefundManualReviewModal, { type RefundTaskItem } from "../components/RefundManualReviewModal"
import { formatCurrency } from "../components/TransactionDetailDrawer"
import type { Event, Registration, Payment } from "shared"

interface CancellationJob {
  id: string
  event_id: string
  status: string
  total_refunds_eligible: number
  refunds_succeeded: number
  refunds_failed: number
  refunds_uncertain: number
  refunds_skipped_attended: number
  created_at: string
  updated_at: string
  completed_at?: string | null
}

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [event, setEvent] = useState<Event | null>(null)
  const [organizer, setOrganizer] = useState<AdminProfile | null>(null)
  const [registrations, setRegistrations] = useState<(Registration & { user_email?: string })[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [cancellationJob, setCancellationJob] = useState<CancellationJob | null>(null)
  const [refundTasks, setRefundTasks] = useState<RefundTaskItem[]>([])
  const [selectedTaskForReview, setSelectedTaskForReview] = useState<RefundTaskItem | null>(null)
  const [loading, setLoading] = useState(true)

  const loadEventData = useCallback(async () => {
    if (!id) return
    try {
      const [eRes, rRes, pRes, jobRes, tasksRes, profiles] = await Promise.all([
        supabase.from("events").select("*").eq("id", id).single(),
        supabase.from("registrations").select("*").eq("event_id", id).order("registered_at"),
        supabase.from("payments").select("*, registrations!inner(event_id)").eq("registrations.event_id", id),
        supabase.from("event_cancellation_jobs").select("*").eq("event_id", id).maybeSingle(),
        supabase.from("refund_task_queue").select("*").eq("event_id", id).order("created_at", { ascending: false }),
        fetchAdminProfiles(),
      ])

      const ev = eRes.data as Event | null
      setEvent(ev)
      const byId = new Map(profiles.map((p) => [p.id, p]))
      if (ev && ev.created_by) {
        setOrganizer(byId.get(ev.created_by) ?? null)
      }
      setRegistrations((rRes.data as any[] || []).map((r) => ({ ...r, user_email: byId.get(r.user_id)?.email })))
      setPayments((pRes.data as Payment[]) || [])
      setCancellationJob((jobRes.data as CancellationJob) || null)

      // Map attendee emails to refund tasks
      const regById = new Map((rRes.data as any[] || []).map((r) => [r.id, r]))
      const tasks = ((tasksRes.data as any[]) || []).map((t) => {
        const reg = regById.get(t.registration_id)
        const email = reg ? byId.get(reg.user_id)?.email : undefined
        return {
          ...t,
          user_email: email,
          event_title: ev?.title,
        }
      })
      setRefundTasks(tasks)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    loadEventData()
  }, [loadEventData])

  const totalRevenue = payments
    .filter((p) => p.status === "success")
    .reduce((sum, p) => sum + p.amount, 0)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <svg className="h-8 w-8 animate-spin text-cluvo-primary" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  if (!event) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center">
        <p className="text-sm text-neutral-500">Event not found.</p>
        <Link to="/events" className="mt-2 inline-block text-sm font-medium text-cluvo-primary">Back to Events</Link>
      </div>
    )
  }

  const isCancellingOrCancelled = event.status === "cancelling" || event.status === "cancelled" || cancellationJob !== null
  const totalEligible = cancellationJob?.total_refunds_eligible || 0
  const totalCompleted = (cancellationJob?.refunds_succeeded || 0) + (cancellationJob?.refunds_skipped_attended || 0)
  const percentComplete = totalEligible > 0 ? Math.round((totalCompleted / totalEligible) * 100) : 0

  return (
    <div className="space-y-6">
      <Link to="/events" className="text-sm text-neutral-500 hover:text-cluvo-primary">&larr; Back to Events</Link>

      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-soft sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold text-neutral-900">{event.title}</h3>
            <p className="mt-1 text-sm text-neutral-500">{event.description || "No description"}</p>
          </div>
          <span className={`shrink-0 self-start rounded-full px-3 py-1 text-xs font-medium ${
            event.status === "published" ? "bg-green-100 text-green-700" :
            event.status === "cancelled" ? "bg-red-100 text-red-700" :
            event.status === "cancelling" ? "bg-amber-100 text-amber-800 ring-1 ring-amber-500/20" :
            event.status === "completed" ? "bg-blue-100 text-blue-700" :
            "bg-yellow-100 text-yellow-700"
          }`}>{event.status}</span>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div><span className="text-neutral-400">Start:</span> <span className="text-neutral-700">{event.start_date ? new Date(event.start_date).toLocaleString() : "—"}</span></div>
          <div><span className="text-neutral-400">End:</span> <span className="text-neutral-700">{event.end_date ? new Date(event.end_date).toLocaleString() : "—"}</span></div>
          <div><span className="text-neutral-400">Location:</span> <span className="text-neutral-700">{event.location || "—"}</span></div>
          <div><span className="text-neutral-400">Capacity:</span> <span className="text-neutral-700">{event.capacity ?? "—"}</span></div>
          <div><span className="text-neutral-400">Booked:</span> <span className="text-neutral-700">{event.booked_count}</span></div>
          <div><span className="text-neutral-400">Price:</span> <span className="text-neutral-700">₹{((event.price || 0) / 100).toFixed(2)}</span></div>
        </div>
      </div>

      {/* Cancellation & Refund Engine Status Card (Milestone B) */}
      {isCancellingOrCancelled && (
        <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-soft sm:p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-neutral-100 pb-3">
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-base font-bold text-neutral-900">
                  Durable Cancellation & Bulk Refund Engine
                </h4>
                <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider ${
                  cancellationJob?.status === "completed" ? "bg-emerald-100 text-emerald-800" :
                  cancellationJob?.status === "requires_manual_review" ? "bg-rose-100 text-rose-800" :
                  "bg-amber-100 text-amber-800 animate-pulse"
                }`}>
                  {cancellationJob?.status?.replace(/_/g, " ") || (event.status === "cancelling" ? "in progress" : "cancelled")}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-neutral-500">
                Audited background refund processing via queue worker with Razorpay idempotency protection
              </p>
            </div>
            <button
              onClick={loadEventData}
              className="self-start sm:self-center inline-flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 shadow-2xs"
            >
              🔄 Refresh Queue
            </button>
          </div>

          {cancellationJob && (
            <div className="space-y-3">
              {/* Progress Bar */}
              <div>
                <div className="flex justify-between text-xs font-semibold text-neutral-600 mb-1">
                  <span>Progress ({totalCompleted} / {totalEligible} processed)</span>
                  <span>{percentComplete}%</span>
                </div>
                <div className="h-2.5 w-full rounded-full bg-neutral-100 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 ${
                      cancellationJob.status === "completed" ? "bg-emerald-500" :
                      cancellationJob.status === "requires_manual_review" ? "bg-rose-500" : "bg-cluvo-primary"
                    }`}
                    style={{ width: `${percentComplete}%` }}
                  />
                </div>
              </div>

              {/* Counters Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-lg bg-neutral-50 border border-neutral-100 p-2.5">
                  <span className="text-[11px] font-medium text-neutral-500 uppercase block">Eligible Refunds</span>
                  <span className="text-lg font-bold text-neutral-900">{totalEligible}</span>
                </div>
                <div className="rounded-lg bg-emerald-50/70 border border-emerald-100 p-2.5">
                  <span className="text-[11px] font-medium text-emerald-800 uppercase block">Refunds Succeeded</span>
                  <span className="text-lg font-bold text-emerald-700">{cancellationJob.refunds_succeeded}</span>
                </div>
                <div className="rounded-lg bg-blue-50/70 border border-blue-100 p-2.5">
                  <span className="text-[11px] font-medium text-blue-800 uppercase block">Skipped (Attended)</span>
                  <span className="text-lg font-bold text-blue-700">{cancellationJob.refunds_skipped_attended}</span>
                </div>
                <div className={`rounded-lg p-2.5 border ${
                  cancellationJob.refunds_failed > 0 || cancellationJob.refunds_uncertain > 0
                    ? "bg-rose-50 border-rose-200"
                    : "bg-neutral-50 border-neutral-100"
                }`}>
                  <span className={`text-[11px] font-medium uppercase block ${
                    cancellationJob.refunds_failed > 0 ? "text-rose-800 font-bold" : "text-neutral-500"
                  }`}>
                    Manual Review / Blocked
                  </span>
                  <span className={`text-lg font-bold ${
                    cancellationJob.refunds_failed > 0 ? "text-rose-600" : "text-neutral-700"
                  }`}>
                    {cancellationJob.refunds_failed + cancellationJob.refunds_uncertain}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Refund Task Queue Table */}
          <div className="mt-4">
            <h5 className="text-xs font-bold text-neutral-700 uppercase tracking-wider mb-2">
              Refund Task Queue Entries ({refundTasks.length})
            </h5>
            {refundTasks.length === 0 ? (
              <p className="text-xs text-neutral-500">No refund tasks recorded for this event.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-neutral-200">
                <table className="w-full text-left text-xs">
                  <thead className="bg-neutral-50 border-b border-neutral-200 text-neutral-600 font-semibold uppercase tracking-wider">
                    <tr>
                      <th className="px-3 py-2">Attendee</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2 text-center">Status</th>
                      <th className="px-3 py-2 text-center">Attempts</th>
                      <th className="px-3 py-2">Provider Ref / Error</th>
                      <th className="px-3 py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {refundTasks.map((task) => {
                      const isUnresolved = task.status === "manual_review" || task.status === "uncertain" || task.status === "failed"
                      return (
                        <tr key={task.id} className="hover:bg-neutral-50/70 transition-colors">
                          <td className="px-3 py-2.5">
                            <span className="font-semibold text-neutral-800 block truncate max-w-[180px]">
                              {task.user_email || "User ID: " + task.registration_id.slice(0, 8)}
                            </span>
                            <span className="text-[10px] font-mono text-neutral-400">
                              Task: {task.id.slice(0, 8)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right font-bold text-neutral-900 whitespace-nowrap">
                            {formatCurrency(task.amount)}
                          </td>
                          <td className="px-3 py-2.5 text-center whitespace-nowrap">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                              task.status === "completed" ? "bg-emerald-100 text-emerald-800" :
                              task.status === "skipped_attended" ? "bg-blue-100 text-blue-800" :
                              task.status === "manual_review" ? "bg-rose-100 text-rose-800" :
                              task.status === "uncertain" ? "bg-amber-100 text-amber-800" :
                              task.status === "processing" ? "bg-indigo-100 text-indigo-800 animate-pulse" :
                              "bg-neutral-100 text-neutral-600"
                            }`}>
                              {task.status.replace("_", " ")}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-center text-neutral-600 font-mono">
                            {task.attempt_count} / {task.max_attempts}
                          </td>
                          <td className="px-3 py-2.5 max-w-[220px]">
                            {task.razorpay_refund_id ? (
                              <span className="font-mono text-[11px] font-semibold text-emerald-700 block truncate">
                                {task.razorpay_refund_id}
                              </span>
                            ) : task.error_message ? (
                              <span className="font-mono text-[10px] text-rose-600 block truncate" title={task.error_message}>
                                {task.error_message}
                              </span>
                            ) : (
                              <span className="text-neutral-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right whitespace-nowrap">
                            {isUnresolved ? (
                              <button
                                onClick={() => setSelectedTaskForReview(task)}
                                className="rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-rose-700 shadow-2xs transition-colors"
                              >
                                Resolve
                              </button>
                            ) : (
                              <span className="text-[11px] text-neutral-400">Settled</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {organizer && (
        <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-soft sm:p-6">
          <h4 className="text-sm font-semibold text-neutral-900">Organizer</h4>
          <div className="mt-3 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cluvo-primary/20 text-sm font-bold text-cluvo-primary">
              {organizer.email?.charAt(0).toUpperCase() || "O"}
            </div>
            <div>
              <p className="text-sm font-medium text-neutral-700">{organizer.first_name} {organizer.last_name}</p>
              <p className="text-xs text-neutral-400">{organizer.email}</p>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-soft sm:p-6">
        <h4 className="text-sm font-semibold text-neutral-900">Revenue (gross, incl. platform fees)</h4>
        <p className="mt-2 text-2xl font-bold text-neutral-900">₹{(totalRevenue / 100).toFixed(2)}</p>
        <p className="text-xs text-neutral-400">{payments.filter((p) => p.status === "success").length} successful payments</p>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-soft sm:p-6">
        <h4 className="text-sm font-semibold text-neutral-900">Registrations ({registrations.length})</h4>
        {registrations.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">No registrations.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200">
                  <th className="px-3 py-2 font-medium text-neutral-600">User</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Status</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Checked In</th>
                  <th className="px-3 py-2 font-medium text-neutral-600">Registered</th>
                </tr>
              </thead>
              <tbody>
                {registrations.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100">
                    <td className="px-3 py-2 text-neutral-700">{r.user_email || "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        r.status === "confirmed" ? "bg-green-100 text-green-700" :
                        r.status === "cancelled" ? "bg-red-100 text-red-700" :
                        r.status === "attended" ? "bg-blue-100 text-blue-700" :
                        "bg-yellow-100 text-yellow-700"
                      }`}>{r.status}</span>
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{r.checked_in ? "Yes" : "No"}</td>
                    <td className="px-3 py-2 text-neutral-500">{new Date(r.registered_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Manual Review Modal */}
      <RefundManualReviewModal
        isOpen={selectedTaskForReview !== null}
        task={selectedTaskForReview}
        onClose={() => setSelectedTaskForReview(null)}
        onResolved={() => {
          loadEventData()
        }}
      />
    </div>
  )
}
