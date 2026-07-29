import { Component, type ErrorInfo, type ReactNode } from "react"

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-8">
          <div className="max-w-md text-center">
            <svg className="mx-auto h-12 w-12 text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            <h2 className="mt-4 text-lg font-semibold text-neutral-900">Something went wrong</h2>
            <p className="mt-2 text-sm text-neutral-500">Please refresh the page and try again.</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-6 rounded-lg bg-[#C2185B] px-6 py-2 text-sm font-medium text-white hover:bg-[#A0154A]"
            >
              Refresh this page
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
