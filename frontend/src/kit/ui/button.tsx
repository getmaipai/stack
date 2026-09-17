// Copied from home's kit until KIT-01 extracts `@maipai/ui`; do not edit here.
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/kit/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // 48px is the kit's hard minimum touch target (docs/UI.md); "default",
      // "lg" and "icon" clear it directly. "xs"/"sm"/"icon-xs"/"icon-sm"/
      // "icon-lg" stay visually compact (desktop/mouse-only, never the
      // only way to reach an action a touch or TV surface must also use)
      // but keep the same 48px hit area with a transparent pseudo-
      // element, the technique the accessibility audit established for
      // Switch's track and the select-mode checkbox: the target and the
      // artwork are different things.
      size: {
        default:
          "h-12 gap-1.5 px-4 text-base has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        // Deliberate type-floor exception (docs/UI.md, lane 7 item 3,
        // 2026-09-13): the "xs" size, a fixed h-6 (24px) button too
        // short for 16px text - a caller choosing "xs" over "default"
        // (which is already text-base) is asking for the compact
        // option on purpose.
        xs: "relative h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs before:absolute before:-inset-3 before:content-[''] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "relative h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] before:absolute before:-inset-2.5 before:content-[''] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-14 gap-1.5 px-6 text-lg has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-12",
        "icon-xs":
          "relative size-6 rounded-[min(var(--radius-md),10px)] before:absolute before:-inset-3 before:content-[''] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "relative size-7 rounded-[min(var(--radius-md),12px)] before:absolute before:-inset-2.5 before:content-[''] in-data-[slot=button-group]:rounded-lg",
        // Touch-target-floor fix (docs/UI.md, BACKLOG.md lane 8 item 1,
        // 2026-09-13): every call site using this size reached it via a
        // raw `size-9` className override, never this variant, so it had
        // never received the same hit-area treatment as its `xs`/`sm`
        // siblings - a live measurement caught the composer's send,
        // dictate, cancel and stop-speaking buttons, plus "New chat" and
        // "Chat options", all real 36x36 targets. `-inset-1.5` (6px) on
        // a 36px box reaches the 48px floor.
        "icon-lg": "relative size-9 before:absolute before:-inset-1.5 before:content-['']",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
