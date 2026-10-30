import { useEffect, useState } from "react"
import { supabase } from "../../supabase"
import type { Event } from "shared"
import CancellationProgressModal from "./cancellation-progress-modal"

interface Props {
  event: Event
  onClose: () => void
  onCancelled: () => void
}

export default function CancelEventConfirmDialog({ event, onClose, onCancelled }: Props) {
  const [refundTotal, setRefundTotal] = useState<number | null>(null)
  const [refundCount, setRefundCount] = useState(0)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [totalEligible, setTotalEligible] = useState<number>(0)

  useEffect(() => {
    let alive = true
    async function loadSummary() {
      try {
        const { data, error } = await supabase
          .from("registrations")
          .select("id, payments(amount, status)")
          .eq("event_id", event.id)
          .eq("status", "confirmed")
          .is("deleted_at", null)
        if (!alive) return
        if (error) {
          setError(error.message)
        } else {
          let total = 0
          let count = 0
          for (const reg of (data || []) as { payments: { amount: number; status: string }[] | null }[]) {
            const payment = reg.payments?.[0]
            if (payment && payment.status === "success" && payment.amount > 0) {
              total += payment.amount
              count += 1
            }
          }
          setRefundTotal(total)
          setRefundCount(count)
        }
      } finally {
        if (alive) setSummaryLoading(false)
      }
    }
    loadSummary()
    return () => { alive = false }
  }, [event.id])

  async function handleConfirm() {
    setConfirming(true)
    setError(null)
    try {
      const { data, error } = await supabase.functions.invoke("cancel-event", {
        body: { event_id: event.id },
      })
      if (error) {
        let msg = error.message
        try {
          const body = await (error as { context?: Response }).context?.clone().json()
          if (body?.error) msg = body.error
        } catch {}
        setError(msg)
        setConfirming(false)
        return
      }
      if (data?.error) {
        setError(data.error)
        setConfirming(false)
        return
      }
      if (data?.job_id) {
        setActiveJobId(data.job_id)
        setTotalEligible(data.total_refunds_eligible ?? refundCount)
        setConfirming(false)
        return
      }
      onCancelled()
    } catch (e) {
      setError((e as Error).message)
      setConfirming(false)
    }
  }

  if (activeJobId) {
    return (
      <CancellationProgressModal
        event={event}
        jobId={activeJobId}
        initialEligible={totalEligible}
        onClose={onClose}
        onCompleted={onCancelled}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-xl bg-white p-5 shadow-xl sm:p-6">
        <h3 className="text-lg font-semibold text-neutral-900">Cancel Event</h3>
        <p className="mt-1 text-sm text-neutral-500">"{event.title}"</p>
        <p className="mt-3 text-sm text-neutral-600">
          Are you sure? This will cancel the event and notify attendees.
        </p>
        {(summaryLoading || refundCount > 0) && (
          <div className="mt-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            {summaryLoading ? (
              "Calculating refunds..."
            ) : (
              <>
                <span className="font-bold">₹{((refundTotal || 0) / 100).toLocaleString("en-IN")}</span>
                {" "}will be refunded to {refundCount} attendee{refundCount !== 1 ? "s" : ""}.
              </>
            )}
          </div>
        )}
        {error && (
          <p className="mt-2 text-sm text-red-500">{error}</p>
        )}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:gap-3">
          <button
            onClick={onClose}
            className="w-full rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 sm:flex-1"
            disabled={confirming}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={summaryLoading || confirming}
            className="w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 sm:flex-1"
          >
            {confirming ? "Cancelling..." : "Confirm Cancellation"}
          </button>
        </div>
      </div>
    </div>
  )
}
