interface StatCardProps {
  title: string
  value: number | string
  label: string
}

export default function StatCard({ title, value, label }: StatCardProps) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-soft">
      <p className="text-sm text-neutral-500">{title}</p>
      <p className="mt-1 text-3xl font-bold text-neutral-900">{value}</p>
      <p className="mt-1 text-xs text-neutral-400">{label}</p>
    </div>
  )
}
