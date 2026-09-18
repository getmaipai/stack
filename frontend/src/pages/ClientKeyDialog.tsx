import { type FormEvent, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/kit/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/kit/ui/dialog";
import { Input } from "@/kit/ui/input";

export function ClientKeyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (key: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post("/stack/v1/operator/setup", { password });
      const result = await api.post<{ key: string }>("/stack/v1/clients", { name: "Stack local tool", allowedRoles: ["chat"] });
      onCreated(result.key);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The password could not be saved.");
    } finally {
      setSaving(false);
    }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Set your operator password</DialogTitle><DialogDescription>The password was deferred until the first key. It secures the board and future keys on this computer.</DialogDescription></DialogHeader><form className="space-y-5" onSubmit={submit}><label className="block space-y-2 text-base font-medium" htmlFor="deferred-password">Operator password<Input id="deferred-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <p className="text-base text-destructive" role="alert">{error}</p>}<Button type="submit" disabled={saving}>{saving ? "Saving..." : "Set password and create key"}</Button></form></DialogContent></Dialog>;
}
