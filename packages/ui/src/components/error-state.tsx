import { AlertCircle } from "lucide-react"
import { cn } from "../lib/utils"
import { Button } from "../ui/button"

interface ErrorStateProps {
  title?: string
  message?: string
  onRetry?: () => void
  className?: string
}

export function ErrorState({
  title = "Something went wrong",
  message = "An unexpected error occurred. Please try again.",
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 py-12 text-center", className)}>
      <AlertCircle className="h-10 w-10 text-error" />
      <h3 className="text-lg font-semibold text-neutral-800">{title}</h3>
      <p className="max-w-sm text-sm text-neutral-500">{message}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      )}
    </div>
  )
}
