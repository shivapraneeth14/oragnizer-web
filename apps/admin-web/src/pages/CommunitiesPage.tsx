import { useEffect, useState, useCallback } from "react"
import { Link } from "react-router-dom"
import { supabase } from "../supabase"
import { fetchAdminProfiles } from "../lib/admin-profiles"
import { COMMUNITY_CLIENT_COLUMNS_SELECT, type Community } from "shared"

const GRACE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

function daysRemaining(startedAt: string) {
  const due = new Date(new Date(startedAt).getTime() + GRACE_DAYS * DAY_MS).getTime()
  return Math.max(0, Math.ceil((due - Date.now()) / DAY_MS))
}

export interface CommunityApplicationItem {
  id: string
  user_id: string
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
  community_id?: string | null
  reviewed_by?: string | null
  reviewed_at?: string | null
  created_at: string
  updated_at: string
  applicant_name?: string
  applicant_email?: string
  applicant_username?: string
}

type FilterKey = "all" | "active" | "approvals" | "scheduled"

export default function CommunitiesPage() {
  const [communities, setCommunities] = useState<(Community & { owner_email?: string; deletion_grace_started_at?: string | null })[]>([])
  const [applications, setApplications] = useState<CommunityApplicationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterKey>("all")

  // Modal / Review state
  const [selectedApplication, setSelectedApplication] = useState<CommunityApplicationItem | null>(null)
  const [isRejecting, setIsRejecting] = useState(false)
  const [rejectionReason, setRejectionReason] = useState("")
  const [processingAction, setProcessingAction] = useState(false)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [cSettled, pSettled, appsRes] = await Promise.allSettled([
        supabase.from("communities").select(COMMUNITY_CLIENT_COLUMNS_SELECT).order("created_at", { ascending: false }),
        fetchAdminProfiles(),
        supabase.rpc("get_admin_community_applications"),
      ])

      const profiles = pSettled.status === "fulfilled" ? pSettled.value : []
      const cRes = cSettled.status === "fulfilled" ? cSettled.value : null
      const emailById = new Map(profiles.map((p) => [p.id, p.email]))

      if (cRes?.data) {
        setCommunities(
          (cRes.data as unknown as any[]).map((c) => ({
            ...c,
            owner_email: emailById.get(c.owner_id),
          }))
        )
      }

      if (appsRes.status === "fulfilled" && appsRes.value?.data) {
        setApplications((appsRes.value.data as unknown as CommunityApplicationItem[]) || [])
      }
    } catch (err) {
      console.error("Error loading communities and applications:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Auto-dismiss messages
  useEffect(() => {
    if (actionSuccess) {
      const timer = setTimeout(() => setActionSuccess(null), 6000)
      return () => clearTimeout(timer)
    }
  }, [actionSuccess])

  const pendingApplications = applications.filter((a) => a.status === "pending")

  const filteredCommunities = communities.filter((c: any) => {
    const scheduled = c.deletion_grace_started_at && !c.deleted_at
    if (filter === "scheduled") return scheduled
    if (filter === "active") return !scheduled && !c.deleted_at
    return true
  })

  // Approve action
  const handleApprove = async (app: CommunityApplicationItem) => {
    setActionError(null)
    setProcessingAction(true)
    try {
      const { data, error } = await supabase.rpc("admin_approve_community_application", {
        p_application_id: app.id,
      })

      if (error) throw error
      if (!data || data.ok === false) {
        throw new Error(data?.error || "Failed to approve application.")
      }

      // Dispatch approval email
      supabase.functions
        .invoke("notify-community-approval", {
          body: { application_id: app.id, action: "approved" },
        })
        .catch((e) => console.warn("Email dispatch error:", e))

      setActionSuccess(`✓ "${app.community_name}" has been approved and activated! The organizer has been notified.`)
      setSelectedApplication(null)
      await loadData()
    } catch (err: any) {
      setActionError(err?.message || "Failed to approve community.")
    } finally {
      setProcessingAction(false)
    }
  }

  // Reject action
  const handleRejectSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedApplication) return
    if (!rejectionReason.trim()) {
      setActionError("Please provide a rejection reason.")
      return
    }

    setActionError(null)
    setProcessingAction(true)
    try {
      const { data, error } = await supabase.rpc("admin_reject_community_application", {
        p_application_id: selectedApplication.id,
        p_reason: rejectionReason.trim(),
      })

      if (error) throw error
      if (!data || data.ok === false) {
        throw new Error(data?.error || "Failed to reject application.")
      }

      // Dispatch rejection email with feedback
      supabase.functions
        .invoke("notify-community-approval", {
          body: {
            application_id: selectedApplication.id,
            action: "rejected",
            reason: rejectionReason.trim(),
          },
        })
        .catch((e) => console.warn("Email dispatch error:", e))

      setActionSuccess(`Application for "${selectedApplication.community_name}" has been rejected. Feedback sent to applicant.`)
      setSelectedApplication(null)
      setIsRejecting(false)
      setRejectionReason("")
      await loadData()
    } catch (err: any) {
      setActionError(err?.message || "Failed to reject community.")
    } finally {
      setProcessingAction(false)
    }
  }

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

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h3 className="text-xl font-bold text-neutral-900 tracking-tight">Communities Directory</h3>
        <p className="mt-1 text-sm text-neutral-500">
          Manage active communities, review pending onboarding requests, and oversee platform closures.
        </p>
      </div>

      {/* Global Alerts */}
      {actionSuccess && (
        <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-xs font-semibold text-emerald-900 flex items-center justify-between shadow-xs">
          <span>{actionSuccess}</span>
          <button onClick={() => setActionSuccess(null)} className="text-emerald-700 hover:text-emerald-900">✕</button>
        </div>
      )}
      {actionError && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-xs font-semibold text-red-900 flex items-center justify-between shadow-xs">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="text-red-700 hover:text-red-900">✕</button>
        </div>
      )}

      {/* Ordered Filter Tabs: 1. All, 2. Active, 3. Approvals, 4. Scheduled for closure */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 pb-3">
        <button
          onClick={() => setFilter("all")}
          className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all ${
            filter === "all"
              ? "bg-cluvo-primary text-white shadow-xs"
              : "border border-neutral-200 text-neutral-700 hover:bg-neutral-50"
          }`}
        >
          All Communities ({communities.length})
        </button>

        <button
          onClick={() => setFilter("active")}
          className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all ${
            filter === "active"
              ? "bg-cluvo-primary text-white shadow-xs"
              : "border border-neutral-200 text-neutral-700 hover:bg-neutral-50"
          }`}
        >
          Active ({communities.filter((c: any) => !c.deletion_grace_started_at && !c.deleted_at).length})
        </button>

        <button
          onClick={() => setFilter("approvals")}
          className={`relative rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all flex items-center gap-1.5 ${
            filter === "approvals"
              ? "bg-amber-600 text-white shadow-xs"
              : "border border-amber-300 bg-amber-50/70 text-amber-900 hover:bg-amber-100/80"
          }`}
        >
          <span>Approvals</span>
          {pendingApplications.length > 0 && (
            <span className={`rounded-full px-1.5 py-0.2 text-[10px] font-black ${
              filter === "approvals" ? "bg-white text-amber-800" : "bg-amber-600 text-white"
            }`}>
              {pendingApplications.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setFilter("scheduled")}
          className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all ${
            filter === "scheduled"
              ? "bg-cluvo-primary text-white shadow-xs"
              : "border border-neutral-200 text-neutral-700 hover:bg-neutral-50"
          }`}
        >
          Scheduled for closure ({communities.filter((c: any) => c.deletion_grace_started_at && !c.deleted_at).length})
        </button>
      </div>

      {/* ================= TAB 3: APPROVALS PENDING ================= */}
      {filter === "approvals" ? (
        pendingApplications.length === 0 ? (
          <div className="rounded-2xl border border-neutral-200 bg-white p-12 text-center shadow-xs">
            <span className="text-3xl">✨</span>
            <h4 className="mt-2 text-base font-bold text-neutral-900">No Pending Approvals</h4>
            <p className="mt-1 text-xs text-neutral-500">
              All community onboarding applications have been reviewed. New submissions will appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs text-neutral-500 px-1">
              <span>Showing <strong>{pendingApplications.length}</strong> community application(s) awaiting review</span>
            </div>

            {/* Mobile Cards */}
            <div className="space-y-3 md:hidden">
              {pendingApplications.map((app) => (
                <div key={app.id} className="rounded-xl border border-amber-200 bg-white p-4 shadow-xs space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h4 className="font-bold text-neutral-900 text-sm">{app.community_name}</h4>
                      <p className="text-xs text-neutral-500">{app.city}, {app.country} • {app.category}</p>
                    </div>
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                      Pending
                    </span>
                  </div>

                  <dl className="text-xs space-y-1 text-neutral-600 border-t border-neutral-100 pt-2">
                    <div className="flex justify-between">
                      <dt className="text-neutral-400">Applicant:</dt>
                      <dd className="font-medium">{app.applicant_name || app.contact_email}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-neutral-400">Phone:</dt>
                      <dd className="font-mono">{app.contact_phone}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-neutral-400">Submitted:</dt>
                      <dd>{new Date(app.created_at).toLocaleDateString()}</dd>
                    </div>
                  </dl>

                  <div className="pt-2 border-t border-neutral-100 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => { setSelectedApplication(app); setIsRejecting(false); }}
                      className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-800"
                    >
                      Review & Decide
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-xs">
              <table className="w-full text-left text-xs">
                <thead className="bg-neutral-50 border-b border-neutral-200 text-neutral-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Community Name</th>
                    <th className="px-4 py-3 font-semibold">Applicant / Owner</th>
                    <th className="px-4 py-3 font-semibold">Contact Phone</th>
                    <th className="px-4 py-3 font-semibold">Category & Location</th>
                    <th className="px-4 py-3 font-semibold">Submitted Date</th>
                    <th className="px-4 py-3 font-semibold text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {pendingApplications.map((app) => (
                    <tr key={app.id} className="hover:bg-neutral-50/60 transition-colors">
                      <td className="px-4 py-3">
                        <span className="font-bold text-neutral-900 text-sm block">{app.community_name}</span>
                        <span className="text-[11px] text-neutral-400 truncate max-w-xs block">{app.description}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-neutral-900">{app.applicant_name}</div>
                        <div className="text-[11px] font-mono text-neutral-500">{app.contact_email}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-neutral-700">
                        {app.contact_phone}
                      </td>
                      <td className="px-4 py-3 text-neutral-600">
                        <span className="font-medium text-neutral-800 block">{app.category}</span>
                        <span className="text-[11px] text-neutral-400">{app.city}, {app.country}</span>
                      </td>
                      <td className="px-4 py-3 text-neutral-500">
                        {new Date(app.created_at).toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => { setSelectedApplication(app); setIsRejecting(false); }}
                          className="rounded-lg bg-cluvo-primary px-3 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-cluvo-primary-dark transition-colors"
                        >
                          Review & Decide
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : (
        /* ================= TABS: ALL / ACTIVE / SCHEDULED ================= */
        filteredCommunities.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-neutral-200 bg-white p-12 text-center shadow-xs">
            <p className="text-sm text-neutral-500">
              {filter === "scheduled"
                ? "No communities scheduled for closure."
                : filter === "active"
                ? "No active communities found."
                : "No communities yet."}
            </p>
          </div>
        ) : (
          <>
            {/* Mobile: stacked cards */}
            <div className="mt-6 space-y-3 md:hidden">
              {filteredCommunities.map((c: any) => {
                const scheduled = c.deletion_grace_started_at && !c.deleted_at
                return (
                  <Link key={c.id} to={`/communities/${c.id}`} className="block rounded-xl border border-neutral-200 bg-white p-4 shadow-xs hover:border-neutral-300">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-cluvo-primary text-sm">{c.name}</span>
                      {scheduled ? (
                        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-700">
                          Closure ({daysRemaining(c.deletion_grace_started_at)}d left)
                        </span>
                      ) : c.is_hidden ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">Hidden</span>
                      ) : (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">Active</span>
                      )}
                    </div>
                    <dl className="mt-3 space-y-1 text-xs text-neutral-500">
                      <div className="flex justify-between gap-3">
                        <dt>Owner</dt>
                        <dd className="truncate text-neutral-700">{c.owner_email || "—"}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Members</dt>
                        <dd className="text-neutral-700 font-semibold">{c.member_count}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Events</dt>
                        <dd className="text-neutral-700 font-semibold">{c.event_count}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Created</dt>
                        <dd className="text-neutral-700">{new Date(c.created_at).toLocaleDateString()}</dd>
                      </div>
                    </dl>
                  </Link>
                )
              })}
            </div>

            {/* Desktop: table */}
            <div className="mt-6 hidden overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-xs md:block">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50 text-neutral-600">
                    <th className="px-4 py-3 font-semibold">Community Name</th>
                    <th className="px-4 py-3 font-semibold">Owner Email</th>
                    <th className="px-4 py-3 font-semibold">Members</th>
                    <th className="px-4 py-3 font-semibold">Events</th>
                    <th className="px-4 py-3 font-semibold">Created</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {filteredCommunities.map((c: any) => {
                    const scheduled = c.deletion_grace_started_at && !c.deleted_at
                    return (
                      <tr key={c.id} className="hover:bg-neutral-50/60 transition-colors">
                        <td className="px-4 py-3">
                          <Link to={`/communities/${c.id}`} className="font-bold text-cluvo-primary hover:underline text-sm">
                            {c.name}
                          </Link>
                          {c.is_hidden && !scheduled && <span className="ml-2 text-[10px] font-semibold text-amber-600">(Hidden)</span>}
                        </td>
                        <td className="px-4 py-3 text-neutral-600 font-medium">{c.owner_email || "—"}</td>
                        <td className="px-4 py-3 text-neutral-700 font-semibold">{c.member_count}</td>
                        <td className="px-4 py-3 text-neutral-700 font-semibold">{c.event_count}</td>
                        <td className="px-4 py-3 text-neutral-500">{new Date(c.created_at).toLocaleDateString()}</td>
                        <td className="px-4 py-3">
                          {scheduled ? (
                            <span className="rounded-full bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-600">
                              Closure scheduled · {daysRemaining(c.deletion_grace_started_at)}d left
                            </span>
                          ) : c.is_hidden ? (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Hidden</span>
                          ) : (
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">Active</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      {/* ================= APPLICATION REVIEW DRAWER / MODAL ================= */}
      {selectedApplication && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-2xs"
          onClick={() => !processingAction && setSelectedApplication(null)}
        >
          <div
            className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl border border-neutral-200 animate-in fade-in zoom-in-95 duration-150 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-neutral-100 pb-3">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-800">
                  Community Review & Verification
                </span>
                <h4 className="text-lg font-bold text-neutral-900 mt-0.5">
                  {selectedApplication.community_name}
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setSelectedApplication(null)}
                disabled={processingAction}
                className="rounded-lg p-1 text-neutral-400 hover:text-neutral-700"
              >
                ✕
              </button>
            </div>

            {/* Applicant Profile Bar */}
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 flex items-center justify-between text-xs">
              <div>
                <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wide">Applicant</span>
                <p className="font-bold text-neutral-900">{selectedApplication.applicant_name}</p>
                <p className="text-neutral-500 font-mono text-[11px]">{selectedApplication.applicant_email}</p>
              </div>
              <div className="text-right">
                <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wide">Submitted On</span>
                <p className="text-neutral-700 font-medium">{new Date(selectedApplication.created_at).toLocaleDateString()}</p>
              </div>
            </div>

            {/* Application Information Grid */}
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-neutral-200 p-2.5">
                  <span className="text-neutral-400 block font-medium">Category</span>
                  <span className="font-bold text-neutral-900">{selectedApplication.category}</span>
                </div>
                <div className="rounded-lg border border-neutral-200 p-2.5">
                  <span className="text-neutral-400 block font-medium">Location</span>
                  <span className="font-bold text-neutral-900">
                    {selectedApplication.city}, {selectedApplication.state}, {selectedApplication.country}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-neutral-200 p-2.5">
                  <span className="text-neutral-400 block font-medium">Contact Phone</span>
                  <a href={`tel:${selectedApplication.contact_phone}`} className="font-mono font-bold text-cluvo-primary hover:underline">
                    {selectedApplication.contact_phone}
                  </a>
                </div>
                <div className="rounded-lg border border-neutral-200 p-2.5">
                  <span className="text-neutral-400 block font-medium">Contact Email</span>
                  <a href={`mailto:${selectedApplication.contact_email}`} className="font-mono font-bold text-cluvo-primary hover:underline truncate block">
                    {selectedApplication.contact_email}
                  </a>
                </div>
              </div>

              <div className="rounded-lg border border-neutral-200 p-3">
                <span className="text-neutral-400 block font-medium mb-1">Description</span>
                <p className="text-neutral-800 leading-relaxed whitespace-pre-wrap">{selectedApplication.description}</p>
              </div>

              <div className="rounded-lg border border-neutral-200 p-3">
                <span className="text-neutral-400 block font-medium mb-1">Community Rules</span>
                <p className="text-neutral-800 leading-relaxed whitespace-pre-wrap">{selectedApplication.rules}</p>
              </div>

              {selectedApplication.tags && selectedApplication.tags.length > 0 && (
                <div>
                  <span className="text-neutral-400 block font-medium mb-1">Tags</span>
                  <div className="flex flex-wrap gap-1">
                    {selectedApplication.tags.map((tag, idx) => (
                      <span key={idx} className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold text-neutral-700">
                        #{tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Rejection Form Input */}
            {isRejecting ? (
              <form onSubmit={handleRejectSubmit} className="space-y-3 border-t border-neutral-200 pt-3">
                <div className="rounded-lg bg-red-50 p-3 text-xs text-red-800 border border-red-200">
                  Please provide feedback explaining why this application is rejected. This reason will be sent to the organizer so they can correct and re-submit.
                </div>
                <div>
                  <label className="block text-xs font-bold text-neutral-700 mb-1">
                    Rejection Feedback Reason <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    required
                    rows={3}
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                    placeholder="e.g. Phone number could not be verified; or community description lacks clear event agenda."
                    className="w-full rounded-lg border border-neutral-300 p-2.5 text-xs text-neutral-900 focus:border-cluvo-primary focus:outline-none"
                  />
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsRejecting(false)}
                    disabled={processingAction}
                    className="rounded-lg border border-neutral-200 px-3.5 py-2 text-xs font-semibold text-neutral-700 hover:bg-neutral-100"
                  >
                    Back to Review
                  </button>
                  <button
                    type="submit"
                    disabled={processingAction}
                    className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {processingAction ? "Rejecting..." : "Confirm Rejection"}
                  </button>
                </div>
              </form>
            ) : (
              /* Decision Buttons */
              <div className="flex items-center justify-between gap-3 pt-3 border-t border-neutral-200">
                <button
                  type="button"
                  onClick={() => setIsRejecting(true)}
                  disabled={processingAction}
                  className="rounded-xl border border-red-300 px-4 py-2.5 text-xs font-bold text-red-700 hover:bg-red-50 transition-colors"
                >
                  ❌ Reject Application
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedApplication(null)}
                    disabled={processingAction}
                    className="rounded-xl border border-neutral-200 px-4 py-2.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-100"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApprove(selectedApplication)}
                    disabled={processingAction}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 px-5 py-2.5 text-xs font-bold text-white shadow-xs hover:bg-emerald-800 disabled:opacity-50 transition-colors"
                  >
                    {processingAction ? (
                      <>
                        <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Approving...
                      </>
                    ) : (
                      "✅ Approve & Activate Community"
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
