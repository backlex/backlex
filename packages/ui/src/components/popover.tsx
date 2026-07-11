import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@backlex/ui/lib/utils"
import { ScrollArea } from "@backlex/ui/components/scroll-area"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 flex w-72 origin-(--radix-popover-content-transform-origin) flex-col gap-4 rounded-surface bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/5 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 dark:ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("text-base font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

/**
 * Scrollable body for a `p-0` popover with pinned header/footer bars.
 *
 * Radix's ScrollArea viewport can't flex-fill inside a max-height container
 * (its percentage height doesn't resolve against a `flex-1` parent in
 * Chromium — same limitation the dialog body-scroll pattern works around),
 * so the viewport must be capped explicitly. This bakes the cap in once:
 * the body tops out at `maxHeight`, shrinking to the popover's available
 * screen space (Radix's `--radix-popover-content-available-height`) minus
 * `reserve` — the combined height of the pinned chrome around it — so the
 * pinned bars always stay on screen and the body scrolls instead.
 */
function PopoverScrollBody({
  maxHeight = 280,
  reserve = 120,
  ...props
}: React.ComponentProps<typeof ScrollArea> & {
  /** Tallest the body may grow when screen space allows, in px. */
  maxHeight?: number
  /** Combined height of the pinned header/footer bars around it, in px. */
  reserve?: number
}) {
  return (
    <ScrollArea
      viewportStyle={{
        maxHeight: `min(${maxHeight}px, calc(var(--radix-popover-content-available-height) - ${reserve}px))`,
      }}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverScrollBody,
  PopoverTitle,
  PopoverTrigger,
}
