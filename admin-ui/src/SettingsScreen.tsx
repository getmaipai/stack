import { useState } from "react";
import { Pill } from "./kit";
import { Button } from "@maipai/ui/src/ui/button";
import { Card, CardContent } from "@maipai/ui/src/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@maipai/ui/src/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { Input } from "@maipai/ui/src/ui/input";
import { Label } from "@maipai/ui/src/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maipai/ui/src/ui/select";
import { Switch } from "@maipai/ui/src/ui/switch";
import { api } from "./api";
import type { Setting, SettingValue, SettingsDoc } from "./api";
import { coerce, pendingKeys, settingValue, settingsForScreen } from "./manage";
import { ConfirmButton, Failure, Loading, plainError, useLoad } from "./shared";
import type { Notify } from "./screens";

/** Whether the Stack says a secret already has a value. The API only reveals whether it is set, never the value itself. */
function secretIsSet(s: Setting): boolean {
  const v = s.pending ?? s.in_effect;
  return v !== null && v !== undefined && v !== "";
}

function Field({ s, value, typed, error, onChange, onRemove, onSaveNow }: { s: Setting; value: SettingValue; typed?: string; error?: string; onChange: (raw: string | boolean) => void; onRemove?: () => void; onSaveNow?: () => void }) {
  const id = `set-${s.key}`;
  return (
    <div className="flex flex-col gap-1.5 py-3">
      <div className="flex items-center gap-3">
        <Label htmlFor={id} className="me-auto text-sm font-medium">{s.label}{s.level !== "basic" && <Pill className="ms-2">{s.level}</Pill>}</Label>
        {s.secret && <span className="text-xs text-muted-foreground" role="status">{secretIsSet(s) ? "Set" : "Not set"}</span>}
        {s.secret && <Button variant="ghost" size="sm" onClick={() => onRemove?.()}>Remove</Button>}
        {!s.secret && s.selector === "boolean" && <Switch id={id} checked={value === true} onCheckedChange={(v) => onChange(v)} />}
        {!s.secret && s.selector === "select" && (
          <Select value={String(value ?? "")} onValueChange={(v) => onChange(v)}>
            <SelectTrigger id={id} className="w-56 max-w-[55vw]"><SelectValue /></SelectTrigger>
            <SelectContent>{(s.range?.options ?? []).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {s.secret && (
          <Input id={id} type="password" autoComplete="off" placeholder="Paste to set" className="w-56 max-w-[55vw]" value={typed ?? ""} aria-invalid={error ? true : undefined} onChange={(e) => onChange(e.target.value)} />
        )}
        {s.secret && typed && onSaveNow && <Button size="sm" onClick={onSaveNow}>Save</Button>}
        {!s.secret && (s.selector === "number" || s.selector === "text") && (
          <Input id={id} className="w-56 max-w-[55vw]" inputMode={s.selector === "number" ? "numeric" : undefined} value={String(value ?? "")} aria-invalid={error ? true : undefined} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
      <p className="text-xs text-muted-foreground">{s.help}</p>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      {s.needs_restart && <p className="text-xs text-muted-foreground">Needs a restart to take effect.</p>}
    </div>
  );
}

/** Screen 6: a generic renderer over the declared settings. Role switches live on their own screens. */
export function SettingsScreen({ notify }: { refresh: () => void; notify: Notify }) {
  const doc = useLoad<SettingsDoc>(() => api.settings());
  const [advanced, setAdvanced] = useState(false);
  const [draft, setDraft] = useState<Record<string, SettingValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (doc.loading) return <Loading />;
  if (!doc.data) return <Failure title="The settings could not be read" message={doc.error ?? "No answer yet."} />;
  const groups = settingsForScreen(doc.data, advanced);
  const pending = pendingKeys(doc.data);
  const dirty = Object.keys(draft).length;

  function change(s: Setting, raw: string | boolean) {
    // An emptied secret box means "leave unchanged", so the key drops out of the draft instead of staging "".
    if (s.secret && typeof raw === "string" && raw === "") {
      setDraft((d) => { const { [s.key]: _gone, ...rest } = d; return rest; });
      setErrors((e) => { const { [s.key]: _gone, ...rest } = e; return rest; });
      return;
    }
    const result = typeof raw === "boolean" ? { value: raw } : coerce(s, raw);
    if ("error" in result) {
      setErrors((e) => ({ ...e, [s.key]: result.error }));
      setDraft((d) => ({ ...d, [s.key]: raw as SettingValue }));
      return;
    }
    setErrors((e) => { const { [s.key]: _gone, ...rest } = e; return rest; });
    setDraft((d) => ({ ...d, [s.key]: result.value }));
  }
  async function save() {
    if (Object.keys(errors).length) { notify("Fix the highlighted fields first. Nothing was saved."); return; }
    setBusy(true);
    try {
      const saved = await api.putSettings(draft);
      doc.set(saved); setDraft({});
      notify("Saved.");
    } catch (e) { notify(plainError(e, "The settings could not be saved. Nothing was changed.")); }
    finally { setBusy(false); }
  }
  // A pasted secret saves and takes effect in one click, so it never waits behind the page-level Save bar.
  async function saveSecret(key: string) {
    const value = draft[key];
    if (value === undefined || value === "") return;
    setBusy(true);
    try {
      await api.putSettings({ [key]: value });
      doc.set(await api.applySettings());
      setDraft((d) => { const { [key]: _gone, ...rest } = d; return rest; });
      notify("Saved and in use.");
    } catch (e) { notify(plainError(e, "The token could not be saved. Nothing was changed.")); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true);
    try { doc.set(await api.applySettings()); notify("Applied. Restart the Stack from Tools so engines pick up the new values."); }
    catch (e) { notify(plainError(e, "The changes could not be applied. Try again.")); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col gap-4">
      <Label className="flex items-center gap-2 text-sm text-muted-foreground"><Switch checked={advanced} onCheckedChange={setAdvanced} />Show more settings (for experts)</Label>
      {dirty > 0 && (
        <div className="sticky bottom-20 z-10 flex flex-wrap items-center gap-3 rounded-2xl border bg-background/85 p-3 shadow-lg backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none md:bottom-4" role="status">
          <span className="me-auto text-sm">{dirty} unsaved {dirty === 1 ? "change" : "changes"}.</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDraft({}); setErrors({}); }}>Discard</Button>
          <Button size="sm" disabled={busy} onClick={() => { void save(); }}>Save</Button>
        </div>
      )}
      {pending.length > 0 && (
        <div className="glass flex flex-wrap items-center gap-3 p-3 text-sm" role="status">
          <span className="me-auto">{pending.length} saved {pending.length === 1 ? "change is" : "changes are"} waiting to take effect.</span>
          <ConfirmButton variant="default" disabled={busy} label="Apply" title="Apply the saved changes?" confirm="Apply" text="The saved values become the ones the Stack uses from its next start. Restart the Stack afterwards from Tools." onConfirm={apply} />
        </div>
      )}
      {groups.map((g, i) => (
        <Collapsible key={g.id} defaultOpen={i === 0} asChild>
          <Card className="gap-0 py-0">
            <CollapsibleTrigger className="group flex w-full items-center gap-3 rounded-xl p-5 text-start transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_5%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring">
              <span className="me-auto"><span className="block font-semibold">{g.label}</span><span className="block text-sm text-muted-foreground">{g.items.length} {g.items.length === 1 ? "setting" : "settings"}</span></span>
              <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="divide-y border-t px-5 pb-2">
                {g.items.map((s) => <Field key={s.key} s={s} value={settingValue(s, draft)} typed={s.key in draft ? String(draft[s.key] ?? "") : undefined} error={errors[s.key]} onChange={(raw) => change(s, raw)} onSaveNow={() => { void saveSecret(s.key); }} onRemove={() => { setDraft((d) => ({ ...d, [s.key]: "" })); setErrors((e) => { const { [s.key]: _gone, ...rest } = e; return rest; }); }} />)}
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      ))}
      {groups.length === 0 && <p className="text-sm text-muted-foreground">No settings to show. Turn on "Show more settings" to see more.</p>}
    </div>
  );
}
