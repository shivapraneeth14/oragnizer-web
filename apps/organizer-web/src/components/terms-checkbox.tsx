import { useState } from "react"
import LegalDialogHost from "./legal-dialog"
import { privacySections } from "../legal/privacy-content"
import { termsSections } from "../legal/terms-content"

interface TermsCheckboxProps {
  value: boolean
  onChange: (value: boolean) => void
}

export default function TermsCheckbox({ value, onChange }: TermsCheckboxProps) {
  const [openDialog, setOpenDialog] = useState<"privacy" | "terms" | null>(null)

  return (
    <>
      <label className="flex cursor-pointer items-start gap-3 text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[#C2185B]"
        />
        <span>
          I agree to the{" "}
          <button
            type="button"
            className="font-medium text-[#C2185B] underline hover:text-[#A0154A]"
            onClick={() => setOpenDialog("privacy")}
          >
            Privacy Policy
          </button>{" "}
          and{" "}
          <button
            type="button"
            className="font-medium text-[#C2185B] underline hover:text-[#A0154A]"
            onClick={() => setOpenDialog("terms")}
          >
            Terms of Service
          </button>
        </span>
      </label>
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
    </>
  )
}
