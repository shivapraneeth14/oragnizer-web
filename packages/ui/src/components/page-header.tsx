import { cn } from "../lib/utils"

interface PageHeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function PageHeader({ title, description, action, className }: PageHeaderProps) {
  return (
    <div className={cn("flex items-center justify-between pb-6", className)}>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-900">{title}</h1>
        {description && <p className="text-sm text-neutral-500">{description}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  )
}
