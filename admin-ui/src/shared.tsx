import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@maipai/ui/src/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@maipai/ui/src/ui/alert";
import { Button } from "@maipai/ui/src/ui/button";
import { Skeleton } from "@maipai/ui/src/ui/skeleton";
import { ApiError } from "./api";

export const plainError = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);

/** Loads once, reloads on demand. A failure keeps the last good data and shows the plain sentence from the API. */
export function useLoad<T>(fn: () => Promise<T>): { data: T | null; error: string | null; loading: boolean; reload: () => void; set: (v: T) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((d) => { if (live) { setData(d); setError(null); } }).catch((e: unknown) => { if (live) setError(plainError(e, "The Stack did not answer. Try again in a moment.")); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, loading, reload, set: setData };
}

export function Loading() {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>;
}
export function Failure({ title = "That did not work", message }: { title?: string; message: string }) {
  return <Alert variant="destructive" role="alert"><AlertTitle>{title}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>;
}

/** A button that asks first. The dialog says what will happen; the action runs only on the confirm button. */
export function ConfirmButton({ label, title, text, confirm, onConfirm, variant = "outline", size = "sm", destructive = false, disabled = false, children }: {
  label: ReactNode; title: string; text: string; confirm: string; onConfirm: () => void | Promise<void>;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive"; size?: "sm" | "default"; destructive?: boolean; disabled?: boolean; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} disabled={disabled} onClick={() => setOpen(true)}>{label}</Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{text}</AlertDialogDescription></AlertDialogHeader>
          {children}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={destructive ? "destructive" : "default"} onClick={() => { void onConfirm(); }}>{confirm}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
