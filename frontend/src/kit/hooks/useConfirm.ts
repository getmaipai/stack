import { useCallback, useState } from "react";

// Pairs with ConfirmDialog: a destructive action calls `ask(payload)`
// instead of acting immediately; the dialog reads `target` and calls
// `clear()` on cancel or after the caller's own confirm handler runs.
export function useConfirm<T>(): { target: T | null; ask: (payload: T) => void; clear: () => void } {
  const [target, setTarget] = useState<T | null>(null);
  const ask = useCallback((payload: T) => setTarget(payload), []);
  const clear = useCallback(() => setTarget(null), []);
  return { target, ask, clear };
}
