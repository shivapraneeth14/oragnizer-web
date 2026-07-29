import { useState, useEffect } from "react"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"
import { useAuth } from "../Auth"

const navItems = [
  { id: "dashboard", label: "Dashboard", path: "/dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
  { id: "communities", label: "Communities", path: "/communities", icon: "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" },
  { id: "users", label: "Users", path: "/users", icon: "M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" },
  { id: "events", label: "Events", path: "/events", icon: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" },
]

export default function AdminLayout() {
  const { user, session, loading, isAdmin, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024)
  const [profileOpen, setProfileOpen] = useState(false)

  useEffect(() => {
    const onResize = () => setSidebarOpen(window.innerWidth >= 1024)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  useEffect(() => {
    if (!loading && (!session || !isAdmin)) {
      navigate("/", { replace: true })
    }
  }, [session, isAdmin, loading, navigate])

  if (loading || !session || !isAdmin) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-50">
        <svg className="h-8 w-8 animate-spin text-[#C2185B]" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  const sectionName = navItems.find((n) => location.pathname.startsWith(n.path))?.label || "Dashboard"

  return (
    <div className="flex h-screen bg-neutral-50">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed left-0 top-0 z-30 flex h-full flex-col bg-white shadow-lg transition-all duration-300 ease-in-out ${
          sidebarOpen ? "w-64" : "w-0 -translate-x-full lg:w-16 lg:translate-x-0"
        }`}
      >
        <div className="flex h-16 items-center justify-between border-b border-neutral-200 px-4">
          {sidebarOpen && <span className="text-lg font-bold tracking-wider text-[#C2185B]">CLUVO ADMIN</span>}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
          >
            <svg className={`h-5 w-5 transition-transform ${sidebarOpen ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {navItems.map((item) => (
            <NavLink
              key={item.id}
              to={item.path}
              onClick={() => {
                setProfileOpen(false)
                if (window.innerWidth < 1024) setSidebarOpen(false)
              }}
              className={({ isActive }) =>
                `flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-[#C2185B]/10 text-[#C2185B]"
                    : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-800"
                }`
              }
            >
              <svg className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
              </svg>
              {sidebarOpen && <span>{item.label}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-neutral-200 px-3 py-3">
          {sidebarOpen && (
            <div className="relative">
              <button
                onClick={() => setProfileOpen(!profileOpen)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-neutral-600 hover:bg-neutral-100"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#C2185B]/20 text-xs font-bold text-[#C2185B]">
                  {user?.email?.charAt(0).toUpperCase() || "A"}
                </div>
                <div className="flex-1 truncate text-left">
                  <p className="text-xs font-medium text-neutral-700">{user?.email}</p>
                  <p className="text-xs text-neutral-400">Admin</p>
                </div>
              </button>

              {profileOpen && (
                <div className="absolute bottom-full left-0 mb-2 w-full rounded-lg border border-neutral-200 bg-white shadow-lg">
                  <button
                    onClick={() => { signOut(); setProfileOpen(false) }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          )}
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="flex w-full items-center justify-center rounded-lg px-3 py-2 text-neutral-500 hover:bg-neutral-100"
              title="Expand sidebar"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>
      </aside>

      <main className={`flex-1 transition-all duration-300 ${sidebarOpen ? "lg:pl-64" : "lg:pl-16"} pl-0`}>
        <header className="flex h-16 items-center justify-between border-b border-neutral-200 bg-white px-6">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 lg:hidden"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <h2 className="text-lg font-semibold text-neutral-900 capitalize">{sectionName}</h2>
          </div>
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#C2185B]/20 text-xs font-bold text-[#C2185B]">
            {user?.email?.charAt(0).toUpperCase() || "A"}
          </div>
        </header>

        <div className="overflow-y-auto p-6">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
