import { ReactNode } from "react"
import { Link } from "react-router-dom"

export default function LegalShell({
  title,
  updated,
  children,
}: {
  title: string
  updated: string
  children: ReactNode
}) {
  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
          <Link to="/" className="text-lg font-bold tracking-[0.2em] text-[#C2185B]">
            CLUVO
          </Link>
          <nav className="flex items-center gap-5 text-sm">
            <Link to="/privacy" className="text-neutral-600 transition hover:text-neutral-900">
              Privacy Policy
            </Link>
            <Link to="/terms" className="text-neutral-600 transition hover:text-neutral-900">
              Terms
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold text-neutral-900">{title}</h1>
        <p className="mt-2 text-sm text-neutral-500">Last updated: {updated}</p>
        <div className="prose mt-10 space-y-6 text-[15px] leading-7 text-neutral-700">{children}</div>
      </main>

      <footer className="border-t border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-3xl flex-col items-center justify-between gap-3 px-6 py-6 text-sm text-neutral-500 sm:flex-row">
          <span>&copy; {new Date().getFullYear()} Cluvo</span>
          <div className="flex items-center gap-5">
            <Link to="/privacy" className="transition hover:text-neutral-900">
              Privacy Policy
            </Link>
            <Link to="/terms" className="transition hover:text-neutral-900">
              Terms
            </Link>
            <a href="mailto:supp.cluvo@gmail.com" className="transition hover:text-neutral-900">
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
