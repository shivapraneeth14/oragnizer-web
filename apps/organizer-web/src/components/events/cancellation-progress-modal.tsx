import { useEffect, useState } from "react"
import { supabase } from "../../supabase"
import type { Event } from "shared"

interface Props {
  event: Event
  jobId: string
  initialEligible: number
  onClose: () => void
  onCompleted: () => void
}

export default function CancellationProgressModal({
  event,
  jobId,
  initialEligible,
  onClose,
  onCompleted,
}: Props) {
  const [job, setJob] = useState<any>(null)

  useEffect(() => {
    let alive = true

    async function loadJob() {
      const { data } = await supabase
        .from("event_cancellation_jobs")
        .select("*")
        .eq("id", jobId)
        .maybeSingle()

      if (alive && data) {
        setJob(data)
        if (data.status === "completed") {
          onCompleted()
        }
      }
    }

    loadJob()

    // Realtime subscription
    const channel = supabase
      .channel(`cancellation_job_${jobId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "event_cancellation_jobs",
          filter: `id=eq.${jobId}`,
        },
        (payload) => {
          if (alive && payload.new) {
            setJob(payload.new)
            if (payload.new.status === "completed") {
              onCompleted()
            }
          }
        },
      )
      .subscribe()

    // 3-second fallback polling
    const timer = setInterval(loadJob, 3000)

    return () => {
      alive = false
      clearInterval(timer)
      supabase.removeChannel(channel)
    }
  }, [jobId, onCompleted])

  const total = job?.total_refunds_eligible ?? initialEligible
  const succeeded = job?.refunds_succeeded ?? 0
  const uncertain = job?.refunds_uncertain ?? 0
  const failed = job?.refunds_failed ?? 0
  const pending = Math.max(total - succeeded - failed, 0)
  const percent = total > 0 ? Math.min(Math.round((succeeded / total) * 100), 100) : 100
  const isFinished = job?.status === "completed"
  const isReview = job?.status === "requires_manual_review"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-5 shadow-xl sm:p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-neutral-900">
            {isFinished ? "Event Cancelled" : isReview ? "Action Required" : "Cancelling Event..."}
          </h3>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              isFinished
                ? "bg-emerald-100 text-emerald-800"
                : isReview
                ? "bg-amber-100 text-amber-800"
                : "bg-blue-100 text-blue-800 animate-pulse"
            }`}
          >
            {isFinished ? "Completed" : isReview ? "Requires Review" : "In Progress"}
          </span>
        </div>

        <p className="mt-1 text-sm text-neutral-500 truncate">"{event.title}"</p>

        {/* Progress Bar */}
        <div className="mt-4">
          <div className="flex justify-between text-xs font-medium text-neutral-600 mb-1">
            <span>Refunds Progress</span>
            <span>{percent}%</span>
          </div>
          <div className="h-2.5 w-full rounded-full bg-neutral-100 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 rounded-full ${
                isFinished ? "bg-emerald-500" : isReview ? "bg-amber-500" : "bg-blue-600"
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        {/* Breakdown Stats */}
        <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg bg-neutral-50 p-3">
            <span className="text-xs text-neutral-500">Processed</span>
            <p className="text-base font-semibold text-neutral-900">
              {succeeded} <span className="text-xs font-normal text-neutral-400">/ {total}</span>
            </p>
          </div>
          <div className="rounded-lg bg-neutral-50 p-3">
            <span className="text-xs text-neutral-500">Pending / In-Flight</span>
            <p className="text-base font-semibold text-neutral-900">{pending}</p>
          </div>
          {uncertain > 0 && (
            <div className="rounded-lg bg-blue-50 p-3 col-span-2">
              <span className="text-xs text-blue-700">Provider Verification (Quiet Period)</span>
              <p className="text-sm font-medium text-blue-900">
                {uncertain} refund(s) awaiting bank synchronization.
              </p>
            </div>
          )}
          {failed > 0 && (
            <div className="rounded-lg bg-red-50 p-3 col-span-2">
              <span className="text-xs text-red-700">Requires Manual Attention</span>
              <p className="text-sm font-medium text-red-900">
                {failed} refund(s) could not be completed automatically. Cluvo support has been alerted.
              </p>
            </div>
          )}
        </div>

        {/* Informational Guidance */}
        <div className="mt-4 rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
          <p>
            {isFinished
              ? "All refunds have been successfully dispatched. The event is permanently cancelled."
              : isReview
              ? "Partial cancellation recorded. You may close this window while administrative review takes place."
              : "The event is frozen. New registrations and payments are blocked. You may close this window; refunds continue processing in the background."}
          </p>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
          >
            {isFinished ? "Done" : "Close"}
          </button>
        </div>
      </div>
    </div>
  )
}

