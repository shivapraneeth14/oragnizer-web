import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { AuthProvider } from "./Auth"
import AdminLayout from "./components/AdminLayout"
import ErrorBoundary from "./components/ErrorBoundary"
import LoginPage from "./pages/LoginPage"
import ForgotPasswordPage from "./pages/ForgotPasswordPage"
import ResetPasswordPage from "./pages/ResetPasswordPage"
import DashboardPage from "./pages/DashboardPage"
import CommunitiesPage from "./pages/CommunitiesPage"
import CommunityDetailPage from "./pages/CommunityDetailPage"
import UsersPage from "./pages/UsersPage"
import UserDetailPage from "./pages/UserDetailPage"
import EventsPage from "./pages/EventsPage"
import EventDetailPage from "./pages/EventDetailPage"

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route element={<AdminLayout />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/communities" element={<CommunitiesPage />} />
            <Route path="/communities/:id" element={<CommunityDetailPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/users/:id" element={<UserDetailPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/events/:id" element={<EventDetailPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  )
}
