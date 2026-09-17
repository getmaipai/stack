// Copied from home's kit until KIT-01 extracts `@maipai/ui`; do not edit here.
"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

// "system" rather than a `next-themes` `useTheme()` read: no next-themes
// `ThemeProvider` is mounted here (the shell has no theme provider at all
// yet), so that hook would only ever resolve its own "system" default -
// dead weight for one hardcoded string. Revisit once the appearance
// setting (docs/plans/session-b-ui.md step 2, `ui.appearance`) exists:
// pass its resolved value through here instead.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="system"
      // The deleted hand-rolled Toast provider set this explicitly
      // (docs/dev.md); Sonner's own default is ~4s. Kept at the same
      // value rather than silently landing on the library's default (a
      // code review, 2026-09-05, caught the drop).
      duration={6000}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
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

export { Toaster }
