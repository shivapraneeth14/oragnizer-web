import { useState, useEffect } from "react"
import { supabase } from "../../supabase"
import { supabaseFetch } from "../../supabase-fetch"

interface Props {
  communityId: string | undefined
}

interface Beneficiary {
  id: string
  cashfree_beneficiary_id: string
  account_holder: string
  bank_account_number: string
  bank_ifsc: string
  label: string
  is_active: boolean
}

export default function PaymentAccounts({ communityId }: Props) {
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([])

  const [showAddForm, setShowAddForm] = useState(false)
  const [accountHolder, setAccountHolder] = useState("")
  const [ifsc, setIfsc] = useState("")
  const [accountNumber, setAccountNumber] = useState("")
  const [label, setLabel] = useState("")
  const [savingBeneficiary, setSavingBeneficiary] = useState(false)

  const [error, setError] = useState("")

  useEffect(() => {
    if (!communityId) return
    loadBeneficiaries()
  }, [communityId])

  async function loadBeneficiaries() {
    if (!communityId) return
    const { data } = await supabase
      .from("community_beneficiaries")
      .select("*")
      .eq("community_id", communityId)
      .order("created_at", { ascending: false })
    if (data) setBeneficiaries(data as Beneficiary[])
  }

  const handleSaveBeneficiary = async () => {
    if (!accountHolder.trim() || !ifsc.trim() || !accountNumber.trim()) {
      setError("All bank fields are required")
      return
    }
    setSavingBeneficiary(true)
    setError("")
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) { setError("Not authenticated"); return }
      const res = await supabaseFetch("/functions/v1/create-beneficiary", token, {
        community_id: communityId,
        bank_account_holder: accountHolder.trim(),
        bank_ifsc: ifsc.trim(),
        bank_account_number: accountNumber.trim(),
        label: label.trim() || undefined,
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || "Failed to save beneficiary"); return }
      setShowAddForm(false)
      setAccountHolder("")
      setIfsc("")
      setAccountNumber("")
      setLabel("")
      loadBeneficiaries()
    } catch {
      setError("Something went wrong")
    }
    setSavingBeneficiary(false)
  }

  const handleSwitchBeneficiary = async (beneficiaryId: string) => {
    setError("")
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) { setError("Not authenticated"); return }
      const res = await supabaseFetch("/functions/v1/switch-active-beneficiary", token, {
        community_id: communityId,
        beneficiary_id: beneficiaryId,
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || "Failed to switch"); return }
      loadBeneficiaries()
    } catch {
      setError("Something went wrong")
    }
  }

  const handleRemoveBeneficiary = async (beneficiary: Beneficiary) => {
    if (!window.confirm(`Remove "${beneficiary.label || beneficiary.account_holder}"?`)) return
    setError("")
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) { setError("Not authenticated"); return }
      const res = await supabaseFetch("/functions/v1/remove-beneficiary", token, {
        community_id: communityId,
        beneficiary_id: beneficiary.id,
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || "Failed to remove"); return }
      loadBeneficiaries()
    } catch {
      setError("Something went wrong")
    }
  }

  return (
    <div>
      <h3 className="text-xl font-semibold text-neutral-900">Payment Accounts</h3>
      <p className="mt-2 text-sm text-neutral-500">
        Manage your saved bank accounts. The active account is used for withdrawals from the Payout page.
      </p>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-6 space-y-2">
        {beneficiaries.map((b) => (
          <div key={b.id} className={`flex items-center justify-between rounded-lg border p-3 text-sm ${b.is_active ? "border-[#C2185B] bg-[#C2185B]/5" : "border-neutral-200"}`}>
            <div className="flex items-center gap-3 min-w-0">
              <input
                type="radio"
                name="active_beneficiary"
                checked={b.is_active}
                onChange={() => handleSwitchBeneficiary(b.id)}
                className="shrink-0 accent-[#C2185B]"
              />
              <div className="min-w-0">
                <p className="font-medium text-neutral-800 truncate">{b.label || b.account_holder}</p>
                <p className="text-xs text-neutral-500 truncate">{b.account_holder} · {b.bank_ifsc} · {b.bank_account_number}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!b.is_active && (
                <button
                  onClick={() => handleRemoveBeneficiary(b)}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
        {beneficiaries.length === 0 && (
          <p className="text-sm text-neutral-400 py-4">No bank accounts saved yet.</p>
        )}
      </div>

      {showAddForm && (
        <div className="mt-6 space-y-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
          <h4 className="text-sm font-semibold text-neutral-700">Add Bank Account</h4>
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1">Account Holder Name</label>
            <input value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-[#C2185B] focus:outline-none"
              placeholder="John Doe" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">IFSC Code</label>
              <input value={ifsc} onChange={(e) => setIfsc(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-[#C2185B] focus:outline-none"
                placeholder="HDFC0001234" />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Account Number</label>
              <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-[#C2185B] focus:outline-none"
                placeholder="1234567890" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1">Label (optional)</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-[#C2185B] focus:outline-none"
              placeholder="e.g. Personal, Business" />
          </div>
          <div className="flex gap-3">
            <button onClick={handleSaveBeneficiary} disabled={savingBeneficiary}
              className="rounded-lg bg-[#C2185B] px-6 py-2.5 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50">
              {savingBeneficiary ? "Saving..." : "Save"}
            </button>
            <button onClick={() => { setShowAddForm(false); setError("") }}
              className="rounded-lg border border-neutral-300 px-6 py-2.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100">
              Cancel
            </button>
          </div>
        </div>
      )}

      {!showAddForm && (
        <button onClick={() => setShowAddForm(true)}
          className="mt-4 text-sm font-medium text-[#C2185B] hover:underline">
          + Add Account
        </button>
      )}
    </div>
  )
}
