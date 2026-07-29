import { Component, type ErrorInfo, type ReactNode } from "react"

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-8">
          <div className="max-w-md text-center">
            <h2 className="text-lg font-semibold text-neutral-900">Something went wrong</h2>
            <p className="mt-2 text-sm text-neutral-500">Please refresh the page and try again.</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-6 rounded-lg bg-[#C2185B] px-6 py-2 text-sm font-medium text-white hover:bg-[#A0154A]"
            >
              Refresh
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
