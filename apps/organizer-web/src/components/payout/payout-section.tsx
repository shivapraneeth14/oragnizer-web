import { useState, useEffect } from "react"
import { supabase } from "../../supabase"
import { supabaseFetch } from "../../supabase-fetch"

interface Props {
  communityId: string | undefined
}

export default function PayoutSection({ communityId }: Props) {
  const [walletBalance, setWalletBalance] = useState(0)
  const [beneficiaryId, setBeneficiaryId] = useState("")
  const [accountHolder, setAccountHolder] = useState("")
  const [ifsc, setIfsc] = useState("")
  const [accountNumber, setAccountNumber] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [payouts, setPayouts] = useState<any[]>([])
  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [beneficiaryLoading, setBeneficiaryLoading] = useState(false)

  useEffect(() => {
    if (!communityId) return

    supabase.from("communities").select("wallet_balance, cashfree_beneficiary_id").eq("id", communityId).single().then(({ data }) => {
      if (data) {
        setWalletBalance(data.wallet_balance || 0)
        setBeneficiaryId(data.cashfree_beneficiary_id || "")
      }
    })

    supabase.from("payout_items").select("amount, status, created_at, error_message").eq("community_id", communityId).order("created_at", { ascending: false }).limit(20).then(({ data }) => {
      if (data) setPayouts(data as any[])
    })
  }, [communityId])

  const handleSaveBeneficiary = async () => {
    if (!accountHolder.trim() || !ifsc.trim() || !accountNumber.trim()) {
      setError("All bank fields are required")
      return
    }
    setBeneficiaryLoading(true)
    setError("")
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) { setError("Not authenticated"); return }
      const res = await supabaseFetch("/functions/v1/create-beneficiary", token, {
        community_id: communityId,
        bank_account_holder: accountHolder.trim(),
        bank_ifsc: ifsc.trim(),
        bank_account_number: accountNumber.trim(),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || "Failed to save beneficiary"); return }
      setBeneficiaryId(data.beneficiary_id)
      alert("Bank details saved successfully!")
    } catch {
      setError("Something went wrong")
    }
    setBeneficiaryLoading(false)
  }

  const handleWithdraw = async () => {
    const amount = parseInt(withdrawAmount)
    if (!amount || amount <= 0 || amount > walletBalance) {
      setError("Enter a valid amount within your balance")
      return
    }
    setSubmitting(true)
    setError("")
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) { setError("Not authenticated"); return }
      const res = await supabaseFetch("/functions/v1/withdraw-wallet", token, { community_id: communityId, amount })
      const data = await res.json()
      if (!res.ok) { setError(data.error || "Withdrawal failed"); return }
      alert("Withdrawal initiated! Funds will be transferred within 1-2 business days.")
      setWalletBalance((prev) => prev - amount)
      setWithdrawAmount("")
      supabase.from("payout_items").select("amount, status, created_at, error_message").eq("community_id", communityId).order("created_at", { ascending: false }).limit(20).then(({ data }) => {
        if (data) setPayouts(data as any[])
      })
    } catch {
      setError("Something went wrong")
    }
    setSubmitting(false)
  }

  const statusBadge = (s: string) => {
    const colors: Record<string, string> = {
      pending: "bg-yellow-100 text-yellow-700",
      processing: "bg-blue-100 text-blue-700",
      success: "bg-green-100 text-green-700",
      failed: "bg-red-100 text-red-600",
    }
    return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${colors[s] || "bg-neutral-100 text-neutral-500"}`}>{s}</span>
  }

  return (
    <div>
      <h3 className="text-xl font-semibold text-neutral-900">Payout Settings</h3>
      <p className="mt-2 text-sm text-neutral-500">
        Revenue from paid events is credited to your wallet. A 10% platform commission is applied.
      </p>

      <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-6">
        <div className="flex items-center justify-between mb-4">
          <h4 className="font-semibold text-neutral-800">Wallet Balance</h4>
          <span className="text-2xl font-bold text-[#C2185B]">₹{(walletBalance / 100).toFixed(0)}</span>
        </div>

        {beneficiaryId ? (
          <div className="space-y-4">
            <p className="text-sm text-green-700 font-medium flex items-center gap-2">
              <span>✓ Bank account linked</span>
            </p>
            <div className="flex gap-3">
              <input
                type="number"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="Amount in paise (e.g. 50000 = ₹500)"
                className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-[#C2185B] focus:outline-none"
              />
              <button onClick={handleWithdraw} disabled={submitting}
                className="rounded-lg bg-[#C2185B] px-6 py-2.5 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50">
                {submitting ? "Processing..." : "Withdraw"}
              </button>
            </div>
            <p className="text-xs text-neutral-400">Enter amount in paise (e.g. 50000 = ₹500.00). Minimum withdrawal: ₹100 (10000 paise).</p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-neutral-500">Add your bank account to withdraw funds.</p>
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
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button onClick={handleSaveBeneficiary} disabled={beneficiaryLoading}
              className="rounded-lg bg-[#C2185B] px-6 py-2.5 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50">
              {beneficiaryLoading ? "Saving..." : "Save Bank Details"}
            </button>
          </div>
        )}
      </div>

      {error && !beneficiaryLoading && !submitting && beneficiaryId && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}

      {payouts.length > 0 && (
        <div className="mt-6">
          <h4 className="font-semibold text-neutral-800 mb-3">Payout History</h4>
          <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50">
                  <th className="px-4 py-3 font-medium text-neutral-600">Amount</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Status</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Date</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Note</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p, i) => (
                  <tr key={i} className="border-b border-neutral-100">
                    <td className="px-4 py-3 font-medium text-neutral-700">₹{(p.amount / 100).toFixed(0)}</td>
                    <td className="px-4 py-3">{statusBadge(p.status)}</td>
                    <td className="px-4 py-3 text-neutral-500">{new Date(p.created_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-neutral-500 text-xs">{p.status === "failed" ? p.error_message || "" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
