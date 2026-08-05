import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@backlex/ui/lib/utils"
import { Button } from "@backlex/ui/components/button"
import { ScrollArea } from "@backlex/ui/components/scroll-area"
import { XIcon } from "lucide-react"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // No backdrop-blur here: a full-screen backdrop-filter re-blurs the
        // whole viewport on every repaint beneath/above it (animated cosmos
        // backdrop, dialog body scroll), tanking scroll FPS inside modals.
        "fixed inset-0 isolate z-50 bg-black/45 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-6 rounded-surface bg-popover p-6 text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/5 duration-100 outline-none sm:max-w-md dark:ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          // A dialog that contains a <DialogBody> becomes a three-track grid
          // capped at 85vh: header and footer take what they need, the body
          // track absorbs the rest and scrolls. `minmax(0,1fr)` is what lets
          // the middle row shrink below its content — the default `auto` row
          // refuses to, which is how a footer ends up drawn past the bottom
          // edge and clipped by overflow-hidden.
          //
          // This is deliberately keyed off `:has()` rather than a prop: the
          // layout is a consequence of having a scrolling body, and a prop is
          // one more thing a caller can forget. Dialogs with no DialogBody are
          // untouched and still size to their content.
          "has-[>[data-slot=dialog-body]]:max-h-[85vh] has-[>[data-slot=dialog-body]]:grid-rows-[auto_minmax(0,1fr)_auto] has-[>[data-slot=dialog-body]]:overflow-hidden",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-4 right-4 bg-secondary"
              size="icon-sm"
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  )
}

/**
 * The scrolling middle of a dialog.
 *
 * Use this instead of a hand-rolled `<ScrollArea viewportClassName="max-h-[calc(85vh-10rem)]">`.
 * That pattern needs every dialog to guess its own header + footer + padding
 * budget in rem, and a wrong guess is invisible until a description wraps to a
 * second line — at which point the footer is drawn past the bottom edge and
 * clipped. The budget was wrong by 6px on the booking dialog and nobody could
 * have seen it in a diff.
 *
 * Here the browser measures instead: DialogContent switches to a three-track
 * grid whose middle track is `minmax(0,1fr)`, so the body gets exactly the room
 * left over. Nothing to keep in sync.
 */
function DialogBody({
  className,
  viewportClassName,
  ...props
}: React.ComponentProps<typeof ScrollArea>) {
  return (
    <ScrollArea
      data-slot="dialog-body"
      // `min-h-0` lets the grid track shrink below the content's height; without
      // it the track floors at max-content and the clipping comes straight back.
      className={cn("min-h-0 w-full", className)}
      viewportClassName={viewportClassName}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
