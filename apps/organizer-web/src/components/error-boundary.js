import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Component } from "react";
export default class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, errorInfo) {
        console.error("ErrorBoundary caught:", error, errorInfo);
    }
    render() {
        if (this.state.hasError) {
            if (this.props.fallback)
                return this.props.fallback;
            return (_jsx("div", { className: "flex min-h-screen items-center justify-center bg-neutral-50 p-8", children: _jsxs("div", { className: "max-w-md text-center", children: [_jsx("svg", { className: "mx-auto h-12 w-12 text-neutral-300", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 1.5, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" }) }), _jsx("h2", { className: "mt-4 text-lg font-semibold text-neutral-900", children: "Something went wrong" }), _jsx("p", { className: "mt-2 text-sm text-neutral-500", children: "Please refresh the page and try again." }), _jsx("button", { onClick: () => window.location.reload(), className: "mt-6 rounded-lg bg-[#C2185B] px-6 py-2 text-sm font-medium text-white hover:bg-[#A0154A]", children: "Refresh this page" })] }) }));
        }
        return this.props.children;
    }
}
//# sourceMappingURL=error-boundary.js.map