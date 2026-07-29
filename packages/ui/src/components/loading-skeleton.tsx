import { cn } from "../lib/utils"

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string
}

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-neutral-200", className)}
      {...props}
    />
  )
}

export function CardSkeleton() {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
      <Skeleton className="mb-4 h-4 w-3/4" />
      <Skeleton className="mb-2 h-3 w-1/2" />
      <Skeleton className="h-3 w-1/4" />
    </div>
  )
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      <Skeleton className="h-8 w-full" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-12 w-full rounded-md bg-neutral-200 animate-pulse" />
      ))}
    </div>
  )
}
