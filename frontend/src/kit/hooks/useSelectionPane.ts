import { useCallback, useEffect, useState } from "react";

// One details pane open at a time. Selecting another row replaces its
// content instead of closing the pane frame; selecting the same row, or
// Escape, closes it (spec: "opening another row replaces content without
// closing the pane frame... Escape... closes the pane").
export function useSelectionPane<T extends string = string>(): { selectedId: T | null; select: (id: T) => void; close: () => void } {
  const [selectedId, setSelectedId] = useState<T | null>(null);

  const select = useCallback((id: T) => {
    setSelectedId((current) => (current === id ? null : id));
  }, []);
  const close = useCallback(() => setSelectedId(null), []);

  useEffect(() => {
    if (selectedId === null) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, close]);

  return { selectedId, select, close };
}
