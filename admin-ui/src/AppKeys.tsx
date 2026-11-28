import { useState } from "react";
import { Check, Copy, KeyRound, Plus } from "lucide-react";
import { Button } from "@maipai/ui/src/ui/button";
import { Input } from "@maipai/ui/src/ui/input";
import { Label } from "@maipai/ui/src/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@maipai/ui/src/ui/alert";
import { api } from "./api";
import type { AppKeyRecord } from "./api";
import { ago } from "./format";
import { baseUrl, DEFAULT_SCOPES, scopeLabel, SCOPE_CHOICES, useWords } from "./appKeyWords";
import type { AppKeyScope } from "./appKeyWords";
import { ConfirmButton, Failure, plainError, useLoad } from "./shared";
import { EmptyState, List, ListRow, ListSkeleton, Pill, SectionHeader } from "./kit";
import type { Notify } from "./screens";

/** Connections: the keys other programs use to call the Stack's OpenAI-shaped routes. A key is shown once, when it is made. */
export function AppKeys({ notify }: { notify: Notify }) {
  const keys = useLoad(() => api.appKeys());
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<AppKeyScope[]>(DEFAULT_SCOPES);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ key: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const toggle = (id: AppKeyScope) => setScopes((now) => (now.includes(id) ? now.filter((s) => s !== id) : [...now, id]));

  async function make() {
    setBusy(true); setFormError(null);
    try {
      const made = await api.createAppKey(name, scopes);
      setShown({ key: made.key, name: made.app_key.name }); setCopied(false); setName(""); keys.reload();
    } catch (e) { setFormError(plainError(e, "The key could not be made. Try again.")); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!shown) return;
    try { await navigator.clipboard.writeText(shown.key); setCopied(true); } catch { notify("The key could not be copied. Select it and copy it by hand."); }
  }
  async function revoke(k: AppKeyRecord) {
    try { await api.revokeAppKey(k.id); notify(`The key '${k.name}' was revoked. Programs using it stop working at once.`); keys.reload(); }
    catch (e) { notify(plainError(e, "The key could not be revoked. Try again.")); keys.reload(); }
  }
  async function forget(k: AppKeyRecord) {
    try { await api.forgetAppKey(k.id); keys.reload(); } catch (e) { notify(plainError(e, "The key could not be removed. Try again.")); }
  }

  const list = keys.data?.app_keys ?? [];
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="keys-h" className="flex flex-col gap-3">
        <SectionHeader id="keys-h" eyebrow="Other programs" title="App keys" count={list.filter((k) => k.state === "active").length}
          description={<>A program that speaks the OpenAI format can use this Stack with a key. Set its base address to <code className="font-mono">{baseUrl(window.location.origin)}</code> and its API key to one made here. Keys work on this computer only.</>} />
        {shown && (
          <Alert role="status">
            <KeyRound aria-hidden="true" />
            <AlertTitle>Copy the key for '{shown.name}' now</AlertTitle>
            <AlertDescription>
              <p>This is the only time it is shown. The Stack keeps no copy it can show again; if you lose it, revoke it and make a new one.</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code data-testid="new-key" className="min-w-0 break-all rounded-md bg-muted px-2 py-1 font-mono text-sm">{shown.key}</code>
                <Button size="sm" variant="outline" onClick={() => { void copy(); }}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? "Copied" : "Copy"}</Button>
                <Button size="sm" variant="ghost" onClick={() => setShown(null)}>I have saved it</Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        <form className="glass flex flex-col gap-4 p-4" onSubmit={(e) => { e.preventDefault(); void make(); }}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="key-name">Name</Label>
            <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="For example: Laptop notes app" autoComplete="off" required />
            <p className="text-xs text-muted-foreground">The program or device that will use it, so you know which key is which.</p>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">What it may do</legend>
            {SCOPE_CHOICES.map((s) => (
              <label key={s.id} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={scopes.includes(s.id)} onChange={() => toggle(s.id)} />
                <span><span className="font-medium">{s.label}</span> <span className="text-muted-foreground">{s.help}</span></span>
              </label>
            ))}
          </fieldset>
          {formError && <Failure title="The key was not made" message={formError} />}
          <div><Button type="submit" disabled={busy || name.trim() === "" || scopes.length === 0}><Plus aria-hidden="true" />{busy ? "Making" : "Make a key"}</Button></div>
        </form>
        {keys.error && !keys.data && <Failure title="The keys could not be read" message={keys.error} />}
        {keys.loading && !keys.data && <ListSkeleton rows={2} />}
        {keys.data && list.length === 0 && <EmptyState Icon={KeyRound} title="No app keys yet" text="Make one above when you want a program on this computer to use the Stack. Home does not need one." />}
        {list.length > 0 && (
          <List label="App keys">
            {list.map((k) => (
              <ListRow key={k.id} Icon={KeyRound} tone={k.state === "active" ? "primary" : "muted"} title={k.name}
                pills={<>{k.state === "revoked" && <Pill tone="bad">Revoked</Pill>}{k.scopes.map((s) => <Pill key={s}>{scopeLabel(s)}</Pill>)}</>}
                detail={<>{useWords(k.last_used_at, k.use_count, (iso) => ago(iso))} Starts with <code className="font-mono">{k.prefix}</code>.</>}
                actions={k.state === "active"
                  ? <ConfirmButton label="Revoke" destructive variant="outline" title={`Revoke '${k.name}'?`} confirm="Revoke" text="Any program using this key stops working at once. You can make a new key later." onConfirm={() => revoke(k)} />
                  : <ConfirmButton label="Remove" variant="ghost" title={`Remove '${k.name}' from the list?`} confirm="Remove" text="This only clears the entry. The key already stopped working." onConfirm={() => forget(k)} />} />
            ))}
          </List>
        )}
      </section>
    </div>
  );
}
