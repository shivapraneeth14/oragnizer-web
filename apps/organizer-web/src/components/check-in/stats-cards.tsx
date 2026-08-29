interface Props {
  total: number
  checkedIn: number
  loading: boolean
}

export default function StatsCards({ total, checkedIn, loading }: Props) {
  const remaining = total - checkedIn

  if (loading) {
    return (
      <div className="grid grid-cols-3 gap-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="rounded-lg border border-neutral-200 bg-white p-4 animate-pulse">
            <div className="h-4 w-16 bg-neutral-100 rounded mb-2" />
            <div className="h-8 w-12 bg-neutral-100 rounded" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <p className="text-xs font-medium text-neutral-500 uppercase tracking-wide">Total</p>
        <p className="text-2xl font-bold text-neutral-800 mt-1">{total}</p>
      </div>
      <div className="rounded-lg border border-green-200 bg-green-50 p-4">
        <p className="text-xs font-medium text-green-600 uppercase tracking-wide">Checked In</p>
        <p className="text-2xl font-bold text-green-700 mt-1">{checkedIn}</p>
      </div>
      <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
        <p className="text-xs font-medium text-orange-600 uppercase tracking-wide">Remaining</p>
        <p className="text-2xl font-bold text-orange-700 mt-1">{remaining}</p>
      </div>
    </div>
  )
}
