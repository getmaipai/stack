import { Button } from "@/kit/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/kit/ui/dialog";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  affectedFiles?: string[];
  affectedDependents?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// The one confirmation for a destructive action rail entry (spec:
// "what is affected: files, dependents; the safe default"). Cancel is
// the default-focused, non-destructive button.
export function ConfirmDialog({ open, title, affectedFiles = [], affectedDependents = [], confirmLabel = "Remove", cancelLabel = "Cancel", onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogHeader>
        {affectedFiles.length > 0 && (
          <div>
            <p className="text-sm font-medium">Files removed</p>
            <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">{affectedFiles.map((file) => <li key={file}>{file}</li>)}</ul>
          </div>
        )}
        {affectedDependents.length > 0 && (
          <div>
            <p className="text-sm font-medium">Affects</p>
            <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">{affectedDependents.map((dependent) => <li key={dependent}>{dependent}</li>)}</ul>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" autoFocus onClick={onCancel}>{cancelLabel}</Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
