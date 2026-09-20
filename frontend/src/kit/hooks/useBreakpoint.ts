import { useEffect, useState } from "react";

// The spec's responsive tiers (section 7): under 720 is the drawer tier,
// 720-959 the icon-rail tier, 960-1279 the reduced-column tier, 1280 and
// up the full grid.
export const BREAKPOINTS = { tablet: 720, narrow: 960, wide: 1280 } as const;

export type BreakpointTier = "phone" | "tablet" | "narrow" | "wide";

export interface Breakpoint {
  width: number;
  tier: BreakpointTier;
  under: (px: number) => boolean;
  atLeast: (px: number) => boolean;
}

function tierFor(width: number): BreakpointTier {
  if (width < BREAKPOINTS.tablet) return "phone";
  if (width < BREAKPOINTS.narrow) return "tablet";
  if (width < BREAKPOINTS.wide) return "narrow";
  return "wide";
}

export function useBreakpoint(): Breakpoint {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? BREAKPOINTS.wide : window.innerWidth));
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return { width, tier: tierFor(width), under: (px) => width < px, atLeast: (px) => width >= px };
}
