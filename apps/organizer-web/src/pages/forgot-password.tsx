import { useNavigate } from "react-router-dom"
import { useAuth } from "../auth-context"
import PasswordResetModal from "../components/password-reset-modal"

export default function ForgotPasswordPage() {
  const navigate = useNavigate()
  const goHome = () => navigate("/")
  const { clearMessages } = useAuth()

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-sm">
        <PasswordResetModal
          open
          requireOrganizer
          onClose={() => {
            clearMessages()
            goHome()
          }}
        />
      </div>
    </div>
  )
}