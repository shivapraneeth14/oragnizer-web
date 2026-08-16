import { useState, useEffect } from "react"
import { supabase } from "../../supabase"
import { supabaseFetch } from "../../supabase-fetch"
import { env } from "../../config"

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

interface Transaction {
  created_at: string
  type: "credit" | "debit" | "refund"
  amount: number
  credit_amount: number | null
  debit_amount: number | null
  description: string
  running_balance: number
  event_id?: string | null
  payment_id?: string | null
}

type TypeFilter = "all" | "credit" | "debit" | "refund"

export default function PayoutSection({ communityId }: Props) {
  const [walletBalance, setWalletBalance] = useState(0)
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [transactionsLoading, setTransactionsLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all")
  const [events, setEvents] = useState<{ id: string; title: string }[]>([])
  const [eventFilter, setEventFilter] = useState("all")

  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  const activeBeneficiary = beneficiaries.find((b) => b.is_active)

  useEffect(() => {
    if (!communityId) return
    loadData()
  }, [communityId])

  async function loadData() {
    if (!communityId) return

    const [balanceRes, benRes, eventsRes] = await Promise.all([
      supabase.from("communities").select("wallet_balance").eq("id", communityId).single(),
      supabase.from("community_beneficiaries").select("*").eq("community_id", communityId).order("created_at", { ascending: false }),
      supabase.from("events").select("id, title").eq("community_id", communityId).order("created_at", { ascending: false }),
    ])

    if (balanceRes.data) setWalletBalance(balanceRes.data.wallet_balance || 0)
    if (benRes.data) setBeneficiaries(benRes.data as Beneficiary[])
    if (eventsRes.data) setEvents(eventsRes.data as { id: string; title: string }[])

    loadTransactions(eventFilter === "all" ? undefined : eventFilter)
  }

  async function loadTransactions(eventId?: string) {
    if (!communityId) return
    setTransactionsLoading(true)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) return
      const res = await fetch(`${env.supabaseUrl}/functions/v1/get-wallet-statement?community_id=${communityId}${eventId ? `&event_id=${eventId}` : ""}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (res.ok && data.transactions) setTransactions(data.transactions)
    } catch {
      console.error("Failed to load statement")
    }
    setTransactionsLoading(false)
  }

  const handleWithdraw = async () => {
    const amount = parseInt(withdrawAmount, 10)
    if (!amount || amount <= 0 || amount > walletBalance) {
      setError("Enter a valid amount within your balance")
      return
    }
    if (!activeBeneficiary) {
      setError("No active bank account")
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
      setWalletBalance((prev) => prev - amount)
      setWithdrawAmount("")
      loadData()
    } catch {
      setError("Something went wrong")
    }
    setSubmitting(false)
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

        {activeBeneficiary && (
          <div className="mb-6 rounded-lg border border-[#C2185B] bg-[#C2185B]/5 p-4">
            <p className="text-xs font-medium text-[#C2185B] uppercase tracking-wide mb-1">Active Account</p>
            <p className="font-medium text-neutral-800">{activeBeneficiary.label || activeBeneficiary.account_holder}</p>
            <p className="text-xs text-neutral-500">{activeBeneficiary.account_holder} · {activeBeneficiary.bank_ifsc} · {activeBeneficiary.bank_account_number}</p>
          </div>
        )}

        <div className="space-y-4">
          <div className="flex gap-3">
            <input
              type="number"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
              placeholder="Amount in paise (e.g. 50000 = ₹500)"
              className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-[#C2185B] focus:outline-none"
            />
            <button onClick={handleWithdraw} disabled={submitting || !activeBeneficiary}
              className="rounded-lg bg-[#C2185B] px-6 py-2.5 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50">
              {submitting ? "Processing..." : "Withdraw"}
            </button>
          </div>
          <p className="text-xs text-neutral-400">Enter amount in paise (e.g. 50000 = ₹500.00). Minimum withdrawal: ₹1 (100 paise).</p>
          {!activeBeneficiary && beneficiaries.length === 0 && (
            <p className="text-xs text-neutral-500">Add a bank account in Settings → Payment Accounts to start withdrawing funds.</p>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-8">
        <h4 className="font-semibold text-neutral-800 mb-3">Transaction History</h4>
        <div className="mb-3 flex gap-2 items-center">
          <div className="flex gap-2">
            {(["all", "credit", "debit", "refund"] as TypeFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setTypeFilter(f)}
                className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
                  typeFilter === f ? "bg-[#C2185B] text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                }`}
              >
                {f === "all" ? "All" : f === "credit" ? "Money In" : f === "debit" ? "Withdrawals" : "Refunds"}
              </button>
            ))}
          </div>
          <select
            value={eventFilter}
            onChange={(e) => {
              const value = e.target.value
              setEventFilter(value)
              loadTransactions(value === "all" ? undefined : value)
            }}
            className="ml-auto rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 bg-white focus:border-[#C2185B] focus:outline-none"
          >
            <option value="all">All events</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>{ev.title}</option>
            ))}
          </select>
        </div>
        {transactionsLoading ? (
          <p className="text-sm text-neutral-400">Loading...</p>
        ) : transactions.filter((t) => typeFilter === "all" || t.type === typeFilter).length === 0 ? (
          <p className="text-sm text-neutral-400">No transactions yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50">
                  <th className="px-4 py-3 font-medium text-neutral-600">Date</th>
                  <th className="px-4 py-3 font-medium text-neutral-600">Description</th>
                  <th className="px-4 py-3 font-medium text-neutral-600 text-right">Money In</th>
                  <th className="px-4 py-3 font-medium text-neutral-600 text-right">Money Out</th>
                  <th className="px-4 py-3 font-medium text-neutral-600 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {transactions.filter((t) => typeFilter === "all" || t.type === typeFilter).map((t, i) => (
                  <tr key={i} className={`border-b border-neutral-100 ${t.type === "refund" ? "bg-red-50/40" : ""}`}>
                    <td className="px-4 py-3 text-neutral-500 whitespace-nowrap">
                      {new Date(t.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                    </td>
                    <td className="px-4 py-3 text-neutral-700">
                      {t.description}
                      {t.event_id && events.some((ev) => ev.id === t.event_id) && (
                        <div className="text-xs text-neutral-400 mt-0.5">
                          {events.find((ev) => ev.id === t.event_id)?.title}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-green-700 font-medium">
                      {t.credit_amount ? `₹${(t.credit_amount / 100).toFixed(0)}` : ""}
                    </td>
                    <td className="px-4 py-3 text-right text-red-600 font-medium">
                      {t.debit_amount ? `₹${(t.debit_amount / 100).toFixed(0)}` : ""}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-neutral-800">
                      ₹{(t.running_balance / 100).toFixed(0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
