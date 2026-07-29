import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth-context";
export default function ProtectedRoute({ children }) {
    const { session, loading } = useAuth();
    if (loading) {
        return (_jsx("div", { className: "flex h-screen items-center justify-center bg-neutral-50", children: _jsxs("svg", { className: "h-8 w-8 animate-spin text-[#C2185B]", viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })] }) }));
    }
    if (!session)
        return _jsx(Navigate, { to: "/", replace: true });
    return _jsx(_Fragment, { children: children });
}
//# sourceMappingURL=protected-route.js.map