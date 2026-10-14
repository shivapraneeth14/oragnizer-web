import { createTransport } from "npm:nodemailer@6.9.16"
import { requiredEnv } from "./env.ts"

// SMTP delivery for the custom password-reset OTP flow and the post-reset
// confirmation email. Uses the same Gmail SMTP credentials that Supabase Auth
// uses for the admin-web recovery-link email, but as EDGE FUNCTION secrets
// (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_SENDER_EMAIL), set per
// project via `supabase secrets set` — see docs/ENV.md.
//
// The transport is created per send and closed afterwards so short-lived edge
// runtimes never hold an idle connection. Never put passwords or codes in
// subject lines or logs.

export async function sendCluvoEmail(
  to: string,
  subject: string,
  textBody: string,
): Promise<void> {
  const host = requiredEnv("SMTP_HOST")
  const port = Number(requiredEnv("SMTP_PORT"))
  const user = requiredEnv("SMTP_USER")
  const pass = requiredEnv("SMTP_PASS")
  const sender = requiredEnv("SMTP_SENDER_EMAIL")

  const transport = createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  })

  try {
    await transport.sendMail({
      from: `Cluvo <${sender}>`,
      to,
      subject,
      text: textBody,
    })
  } finally {
    transport.close()
  }
}