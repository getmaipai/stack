// Copied from home's kit until KIT-01 extracts `@maipai/ui`; do not edit here.
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// The kit's one focus ring, in one place. docs/UI.md makes "a visible
// focus ring" a floor the kit refuses to go below (WCAG 2.2 AA 2.4.13),
// and it was copy-pasted into five components before this existed.
//
// The explicit `ring-offset-[var(--background)]` is the whole
// reason this is a constant rather than a convention: Tailwind v4
// declares `--tw-ring-offset-color` with `@property { inherits: false;
// initial-value: #fff }`, so an offset ring paints a white halo on the
// dark palette unless every single component names the color itself.
// A `:root` override cannot fix it - `inherits: false` means it never
// reaches the element. Found in a code review, 2026-09-05.
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]";

/** The same ring with no offset, for controls whose own border already
 * separates them from the background (inputs, selects). */
export const FOCUS_RING_INSET =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]";
