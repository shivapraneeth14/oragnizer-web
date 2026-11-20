import LegalShell from "../components/legal-shell"

export default function DataDeletionPage() {
  return (
    <LegalShell title="Data Deletion" updated="November 20, 2026">
      <p>
        You can delete your chigzo account and its data at any time. This page
        explains how, what is removed, and how long it takes.
      </p>

      <h2 className="text-xl font-semibold text-neutral-900">How to delete your account</h2>
      <ol className="list-decimal space-y-2 pl-6">
        <li>
          Open the chigzo mobile app and go to{" "}
          <strong>Profile → Delete Account</strong>.
        </li>
        <li>Confirm the deletion. You will be signed out immediately.</li>
        <li>
          If you prefer, you can email{" "}
          <a className="text-cluvo-primary underline" href="mailto:chigzo.app@gmail.com">
            chigzo.app@gmail.com
          </a>{" "}
          from the email address on your account to request deletion.
        </li>
      </ol>

      <h2 className="text-xl font-semibold text-neutral-900">What happens next</h2>
      <p>
        Deletion uses a 30-day grace period. During this time your account is
        scheduled for removal and you are signed out. If you log back in within
        30 days, you can cancel the deletion.
      </p>
      <p>
        After 30 days we permanently remove your profile, wishlist, reviews,
        notifications, and community memberships. Registration and payment
        records and audit logs are retained only as required for legal and
        financial purposes, with your personal identifiers removed or unlinked.
      </p>

      <h2 className="text-xl font-semibold text-neutral-900">If you own a community</h2>
      <p>
        Contact us first at{" "}
        <a className="text-cluvo-primary underline" href="mailto:chigzo.app@gmail.com">
          chigzo.app@gmail.com
        </a>{" "}
        — we will help you close or transfer the community before your account is
        deleted.
      </p>
    </LegalShell>
  )
}
