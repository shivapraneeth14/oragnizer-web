import { useEffect, useState } from "react"
import { supabase } from "../supabase"
import StatCard from "../components/StatCard"

export default function DashboardPage() {
  const [counts, setCounts] = useState({ communities: 0, users: 0, events: 0, members: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      supabase.from("communities").select("id", { count: "exact", head: true }),
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("events").select("id", { count: "exact", head: true }),
      supabase.from("community_members").select("id", { count: "exact", head: true }),
    ]).then(([c, p, e, m]) => {
      setCounts({
        communities: c.count ?? 0,
        users: p.count ?? 0,
        events: e.count ?? 0,
        members: m.count ?? 0,
      })
      setLoading(false)
    })
  }, [])

  return (
    <div>
      <h3 className="text-xl font-semibold text-neutral-900">Platform Overview</h3>
      <p className="mt-2 text-sm text-neutral-500">Summary of all activity across Cluvo.</p>
      <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total Communities" value={loading ? "..." : counts.communities} label="All communities on the platform" />
        <StatCard title="Total Users" value={loading ? "..." : counts.users} label="All registered users" />
        <StatCard title="Total Events" value={loading ? "..." : counts.events} label="All events across communities" />
        <StatCard title="Total Memberships" value={loading ? "..." : counts.members} label="Total community memberships" />
      </div>
    </div>
  )
}
