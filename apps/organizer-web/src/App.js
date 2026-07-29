import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./auth-context";
import LandingPage from "./pages/landing";
import DashboardPage from "./pages/dashboard";
import ForgotPasswordPage from "./pages/forgot-password";
import ResetPasswordPage from "./pages/reset-password";
import ProtectedRoute from "./components/protected-route";
import ErrorBoundary from "./components/error-boundary";
export default function App() {
    return (_jsx(BrowserRouter, { children: _jsx(ErrorBoundary, { children: _jsx(AuthProvider, { children: _jsxs(Routes, { children: [_jsx(Route, { path: "/", element: _jsx(LandingPage, {}) }), _jsx(Route, { path: "/forgot-password", element: _jsx(ForgotPasswordPage, {}) }), _jsx(Route, { path: "/reset-password", element: _jsx(ResetPasswordPage, {}) }), _jsx(Route, { path: "/dashboard", element: _jsx(ProtectedRoute, { children: _jsx(DashboardPage, {}) }) }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/", replace: true }) })] }) }) }) }));
}
//# sourceMappingURL=App.js.map