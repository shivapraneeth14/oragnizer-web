import { Component, type ErrorInfo, type ReactNode } from "react";
interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}
interface State {
    hasError: boolean;
    error: Error | null;
}
export default class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props);
    static getDerivedStateFromError(error: Error): State;
    componentDidCatch(error: Error, errorInfo: ErrorInfo): void;
    render(): string | number | bigint | boolean | Iterable<ReactNode> | Promise<string | number | bigint | boolean | import("react").ReactPortal | import("react").ReactElement<unknown, string | import("react").JSXElementConstructor<any>> | Iterable<ReactNode> | null | undefined> | import("react").JSX.Element | null | undefined;
}
export {};
//# sourceMappingURL=error-boundary.d.ts.map