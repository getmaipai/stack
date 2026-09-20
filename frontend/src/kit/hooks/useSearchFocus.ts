import { useEffect } from "react";
import type { RefObject } from "react";

export interface UseSearchFocusOptions {
  /**
   * The persistent shell's header already binds ⌘K/Ctrl+K to its own
   * global search (spec: "⌘K focuses the same field... it is not a
   * separate blank modal" — meaning the shell's field, not a page-local
   * one). A page-local filter field, like CategoryBrowser's, should
   * bind "/" only, or the two listeners fight over the same keystroke.
   * Defaults true for a standalone field outside that shell.
   */
  enableCmdK?: boolean;
}

// "/" outside a text field, and optionally ⌘K/Ctrl+K, focuses the given
// input; Escape blurs it.
export function useSearchFocus(ref: RefObject<HTMLInputElement | null>, options: UseSearchFocusOptions = {}): void {
  const { enableCmdK = true } = options;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if ((enableCmdK && event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
        event.preventDefault();
        ref.current?.focus();
      }
      if (event.key === "Escape" && document.activeElement === ref.current) {
        ref.current?.blur();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ref, enableCmdK]);
}
