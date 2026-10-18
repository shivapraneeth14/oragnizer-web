import { useState } from "react"
import LegalDialogHost from "../legal-dialog"
import { privacySections } from "../../legal/privacy-content"
import { termsSections } from "../../legal/terms-content"
import { feeSections } from "../../legal/fee-sections"
import { deletionSections } from "../../legal/deletion-sections"

type DialogKind = "privacy" | "terms" | "fees" | "deletion" | null

const SUPPORT_EMAIL = "supp.cluvo@gmail.com"

interface RowConfig {
  id: DialogKind | "support"
  title: string
  subtitle: string
}

const rows: RowConfig[] = [
  { id: "privacy", title: "Privacy Policy", subtitle: "How we collect, use, and share your data" },
  { id: "terms", title: "Terms of Service", subtitle: "Rules for using Cluvo" },
  { id: "fees", title: "Fees & Payouts", subtitle: "Platform fee, settlements, and refunds" },
  { id: "support", title: "Support", subtitle: SUPPORT_EMAIL },
  { id: "deletion", title: "Delete Account", subtitle: "How to permanently remove your account" },
]

export default function Privacy() {
  const [openDialog, setOpenDialog] = useState<DialogKind>(null)

  const handleRow = (id: RowConfig["id"]) => {
    if (id === "support") {
      window.location.href = `mailto:${SUPPORT_EMAIL}?subject=Cluvo%20Support`
      return
    }
    setOpenDialog(id)
  }

  return (
    <div>
      <h3 className="text-xl font-semibold text-neutral-900">Privacy & Legal</h3>
      <p className="mt-1 text-sm text-neutral-500">
        Read our policies and manage your account.
      </p>

      <div className="mt-5 divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => handleRow(row.id)}
            className="flex w-full items-center justify-between px-4 py-3.5 text-left transition hover:bg-neutral-50"
          >
            <span>
              <span className="block text-sm font-medium text-neutral-900">{row.title}</span>
              <span className="mt-0.5 block text-xs text-neutral-500">{row.subtitle}</span>
            </span>
            <svg
              className="h-4 w-4 shrink-0 text-neutral-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ))}
      </div>

      <LegalDialogHost
        open={openDialog === "privacy"}
        title="Privacy Policy"
        sections={privacySections}
        onClose={() => setOpenDialog(null)}
      />
      <LegalDialogHost
        open={openDialog === "terms"}
        title="Terms of Service"
        sections={termsSections}
        onClose={() => setOpenDialog(null)}
      />
      <LegalDialogHost
        open={openDialog === "fees"}
        title="Fees & Payouts"
        sections={feeSections}
        onClose={() => setOpenDialog(null)}
      />
      <LegalDialogHost
        open={openDialog === "deletion"}
        title="Delete Account"
        sections={deletionSections}
        onClose={() => setOpenDialog(null)}
      />
    </div>
  )
}
