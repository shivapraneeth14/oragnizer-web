import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { AuthProvider } from "./auth-context"
import LandingPage from "./pages/landing"
import DashboardPage from "./pages/dashboard"
import ForgotPasswordPage from "./pages/forgot-password"
import ResetPasswordPage from "./pages/reset-password"
import ProtectedRoute from "./components/protected-route"
import ErrorBoundary from "./components/error-boundary"

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  )
}
