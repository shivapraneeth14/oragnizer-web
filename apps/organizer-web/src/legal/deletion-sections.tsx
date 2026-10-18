import type { LegalSection } from "./privacy-content"

// Account-deletion guidance for organizers, shown in Settings → Privacy.
// Matches the actual delete-account edge function behaviour: organizers with
// live communities are blocked until they withdraw funds and transfer or close
// those communities; deletion itself is immediate and personal content is
// removed while financial/audit records are retained unlinked.

export const deletionSections: LegalSection[] = [
  {
    heading: "1. How to delete your account",
    body: (
      <p>
        Open the Cluvo mobile app, go to Profile → Delete Account, and confirm.
        Deletion is permanent: your profile, wishlist, reviews, notifications,
        and community memberships are removed.
      </p>
    ),
  },
  {
    heading: "2. If you are an organizer",
    body: (
      <p>
        You cannot delete your account while you still own live communities
        (they hold wallet balances and other users&apos; event data). First
        withdraw your wallet balance, then transfer ownership or close those
        communities, and then delete your account.
      </p>
    ),
  },
  {
    heading: "3. What is retained",
    body: (
      <p>
        Registration and payment records and audit logs are retained for legal
        and financial purposes with your personal identifiers removed or
        unlinked so they can no longer be traced to you.
      </p>
    ),
  },
  {
    heading: "4. Need help?",
    body: (
      <p>
        Email{" "}
        <a className="text-cluvo-primary underline" href="mailto:supp.cluvo@gmail.com">
          supp.cluvo@gmail.com
        </a>{" "}
        and we will process your deletion request.
      </p>
    ),
  },
]
