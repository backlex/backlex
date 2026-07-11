import { cn } from "@backlex/ui/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-surface bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
