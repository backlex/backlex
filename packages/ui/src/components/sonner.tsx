import * as React from "react"
import { Toaster as Sonner, toast, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

// Local theme detection — reads `.dark` off <html> and watches for changes.
// Avoids the next-themes dep; matches the workeros admin's ThemeProvider which
// toggles `.dark` on documentElement.
const useResolvedTheme = (): "light" | "dark" => {
  const [theme, setTheme] = React.useState<"light" | "dark">(() => {
    if (typeof document === "undefined") return "light"
    return document.documentElement.classList.contains("dark") ? "dark" : "light"
  })
  React.useEffect(() => {
    const root = document.documentElement
    const update = () => {
      setTheme(root.classList.contains("dark") ? "dark" : "light")
    }
    const mo = new MutationObserver(update)
    mo.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => mo.disconnect()
  }, [])
  return theme
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useResolvedTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster, toast }
