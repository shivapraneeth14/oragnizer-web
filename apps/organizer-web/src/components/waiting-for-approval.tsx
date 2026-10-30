import { useState } from "react"
import { supabase } from "../supabase"

export interface CommunityApplicationData {
  id: string
  community_name: string
  category: string
  description: string
  city: string
  state: string
  country: string
  contact_email: string
  contact_phone: string
  tags?: string[]
  rules: string
  status: "pending" | "approved" | "rejected"
  rejection_reason?: string | null
  created_at: string
}

interface Props {
  application: CommunityApplicationData
  onSignOut: () => void
  onReapply?: (app: CommunityApplicationData) => void
  onRefresh: () => void
}

export default function WaitingForApproval({
  application,
  onSignOut,
  onReapply,
  onRefresh,
}: Props) {
  const [checking, setChecking] = useState(false)

  const handleRefresh = async () => {
    setChecking(true)
    try {
      await onRefresh()
    } finally {
      setTimeout(() => setChecking(false), 500)
    }
  }

  const isRejected = application.status === "rejected"

  return (
    <div className="w-full space-y-6">
      {/* Status Header */}
      <div className="text-center">
        <div className={`mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl shadow-xs ${
          isRejected ? "bg-red-100 text-red-600 text-2xl" : "bg-amber-100 text-amber-600 text-2xl animate-pulse"
        }`}>
          {isRejected ? "⚠️" : "⏳"}
        </div>
        <h2 className="text-xl font-bold text-neutral-900">
          {isRejected ? "Application Requires Changes" : "Community Sent for Review"}
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          {isRejected
            ? "Your community application was reviewed and requires updates before it can be activated."
            : "Your community has been submitted for review. Please wait for verification."}
        </p>
      </div>

      {/* Main Status Card */}
      <div className="rounded-2xl border border-neutral-200 bg-neutral-50/80 p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-neutral-200/80 pb-3">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-400">
              Community Name
            </span>
            <h3 className="font-bold text-neutral-900 text-base">
              {application.community_name}
            </h3>
          </div>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-bold ${
              isRejected
                ? "bg-red-100 text-red-800"
                : "bg-amber-100 text-amber-800"
            }`}
          >
            {isRejected ? "Action Required" : "Pending Verification"}
          </span>
        </div>

        {/* Rejection Feedback Banner */}
        {isRejected && application.rejection_reason && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 space-y-1">
            <span className="font-bold block">Feedback from Reviewer:</span>
            <p className="leading-relaxed">{application.rejection_reason}</p>
          </div>
        )}

        {/* Informational copy */}
        {!isRejected && (
          <div className="rounded-xl border border-amber-200/80 bg-amber-50/60 p-3 text-[11px] text-amber-900 leading-relaxed">
            ℹ️ To keep our platform trustworthy and high-quality, all new communities are reviewed by our platform admin before going live.
            Once approved, your community will be visible in the mobile app and you will automatically gain full access to your Organizer Dashboard.
          </div>
        )}

        {/* Submitted Details Snapshot */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-neutral-600 bg-white p-3 rounded-xl border border-neutral-200/70">
          <div>
            <span className="text-neutral-400 block font-medium">Category</span>
            <span className="font-semibold text-neutral-800">{application.category}</span>
          </div>
          <div>
            <span className="text-neutral-400 block font-medium">Location</span>
            <span className="font-semibold text-neutral-800">{application.city}, {application.country}</span>
          </div>
          <div>
            <span className="text-neutral-400 block font-medium">Contact Phone</span>
            <span className="font-semibold text-neutral-800">{application.contact_phone}</span>
          </div>
          <div>
            <span className="text-neutral-400 block font-medium">Contact Email</span>
            <span className="font-semibold text-neutral-800 truncate block">{application.contact_email}</span>
          </div>
        </div>

        <div className="text-[10px] text-neutral-400 text-right">
          Submitted on {new Date(application.created_at).toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })}
        </div>
      </div>

      {/* Buttons */}
      <div className="space-y-2 pt-1">
        {isRejected && onReapply ? (
          <button
            type="button"
            onClick={() => onReapply(application)}
            className="w-full rounded-xl bg-cluvo-primary py-2.5 text-xs font-semibold text-white shadow-xs hover:bg-cluvo-primary-dark transition-colors"
          >
            ✏️ Edit & Re-submit Application
          </button>
        ) : (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={checking}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-cluvo-primary py-2.5 text-xs font-semibold text-white shadow-xs hover:bg-cluvo-primary-dark disabled:opacity-50 transition-colors"
          >
            {checking ? (
              <>
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Checking Status...
              </>
            ) : (
              "🔄 Check Verification Status"
            )}
          </button>
        )}

        <button
          type="button"
          onClick={onSignOut}
          className="w-full rounded-xl border border-neutral-200 py-2.5 text-xs font-semibold text-neutral-600 hover:bg-neutral-50 transition-colors"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
