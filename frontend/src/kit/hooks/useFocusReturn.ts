import { useEffect, useRef } from "react";

// Remembers what had focus before `active` became true, and restores it
// when `active` goes false again (spec: "closing restores focus to the
// selected row").
export function useFocusReturn(active: boolean): void {
  const previous = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (active) {
      previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    if (previous.current && document.contains(previous.current)) previous.current.focus();
    previous.current = null;
  }, [active]);
}
