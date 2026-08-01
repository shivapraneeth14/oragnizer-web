import { useState } from "react"
import EditProfile from "./edit-profile"
import PaymentAccounts from "./payment-accounts"
import SocialMedia from "./social-media"
import Privacy from "./privacy"

interface Props {
  communityId: string | undefined
}

type SettingsTab = "edit-profile" | "payment-accounts" | "social-media" | "privacy"

const tabs: { id: SettingsTab; label: string; icon: string }[] = [
  { id: "edit-profile", label: "Edit Profile", icon: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" },
  { id: "payment-accounts", label: "Payment Accounts", icon: "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" },
  { id: "social-media", label: "Social Media", icon: "M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" },
  { id: "privacy", label: "Privacy", icon: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" },
]

export default function SettingsPage({ communityId }: Props) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("edit-profile")

  return (
    <div className="flex gap-6">
      <aside className="w-56 shrink-0">
        <nav className="space-y-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setSettingsTab(tab.id)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                settingsTab === tab.id
                  ? "bg-[#C2185B]/10 text-[#C2185B]"
                  : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-800"
              }`}
            >
              <svg className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={tab.icon} />
              </svg>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        {settingsTab === "edit-profile" && <EditProfile />}
        {settingsTab === "payment-accounts" && <PaymentAccounts communityId={communityId} />}
        {settingsTab === "social-media" && <SocialMedia />}
        {settingsTab === "privacy" && <Privacy />}
      </main>
    </div>
  )
}
