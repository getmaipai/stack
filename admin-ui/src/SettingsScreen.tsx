import { useState } from "react";
import { Badge } from "@maipai/ui/src/ui/badge";
import { Button } from "@maipai/ui/src/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maipai/ui/src/ui/card";
import { Input } from "@maipai/ui/src/ui/input";
import { Label } from "@maipai/ui/src/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maipai/ui/src/ui/select";
import { Switch } from "@maipai/ui/src/ui/switch";
import { api } from "./api";
import type { Setting, SettingValue, SettingsDoc } from "./api";
import { coerce, pendingKeys, settingValue, settingsForScreen } from "./manage";
import { ConfirmButton, Failure, Loading, plainError, useLoad } from "./shared";
import type { Notify } from "./screens";

function Field({ s, value, error, onChange }: { s: Setting; value: SettingValue; error?: string; onChange: (raw: string | boolean) => void }) {
  const id = `set-${s.key}`;
  return (
    <div className="flex flex-col gap-1.5 py-3">
      <div className="flex items-center gap-3">
        <Label htmlFor={id} className="me-auto text-sm font-medium">{s.label}{s.level !== "basic" && <Badge variant="outline" className="ms-2">{s.level}</Badge>}</Label>
        {s.selector === "boolean" && <Switch id={id} checked={value === true} onCheckedChange={(v) => onChange(v)} />}
        {s.selector === "select" && (
          <Select value={String(value ?? "")} onValueChange={(v) => onChange(v)}>
            <SelectTrigger id={id} className="w-56 max-w-[55vw]"><SelectValue /></SelectTrigger>
            <SelectContent>{(s.range?.options ?? []).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {(s.selector === "number" || s.selector === "text") && (
          <Input id={id} className="w-56 max-w-[55vw]" inputMode={s.selector === "number" ? "numeric" : undefined} value={String(value ?? "")} aria-invalid={error ? true : undefined} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
      <p className="text-xs text-muted-foreground">{s.help}</p>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      {s.needs_restart && <p className="text-xs text-muted-foreground">Takes effect after Apply and a restart.</p>}
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
  async function apply() {
    setBusy(true);
    try { doc.set(await api.applySettings()); notify("Applied. Restart the Stack from Tools so engines pick up the new values."); }
    catch (e) { notify(plainError(e, "The changes could not be applied. Try again.")); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Label className="flex items-center gap-2 text-sm"><Switch checked={advanced} onCheckedChange={setAdvanced} />Show advanced settings</Label>
        <div className="ms-auto flex flex-wrap gap-2">
          <Button disabled={busy || dirty === 0} onClick={() => { void save(); }}>{dirty ? `Save ${dirty} ${dirty === 1 ? "change" : "changes"}` : "Save"}</Button>
          <Button variant="ghost" disabled={busy || dirty === 0} onClick={() => { setDraft({}); setErrors({}); }}>Discard</Button>
        </div>
      </div>
      {pending.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-sm" role="status">
          <span className="me-auto">{pending.length} saved {pending.length === 1 ? "change waits" : "changes wait"} for the next start.</span>
          <ConfirmButton variant="default" disabled={busy} label="Apply" title="Apply the saved changes?" confirm="Apply" text="The saved values become the ones the Stack uses from its next start. Restart the Stack afterwards from Tools." onConfirm={apply} />
        </div>
      )}
      {groups.map((g) => (
        <Card key={g.id}>
          <CardHeader><CardTitle className="text-base">{g.label}</CardTitle><CardDescription>{g.items.length} {g.items.length === 1 ? "setting" : "settings"}</CardDescription></CardHeader>
          <CardContent className="divide-y">
            {g.items.map((s) => <Field key={s.key} s={s} value={settingValue(s, draft)} error={errors[s.key]} onChange={(raw) => change(s, raw)} />)}
          </CardContent>
        </Card>
      ))}
      {groups.length === 0 && <p className="text-sm text-muted-foreground">No settings to show. Switch on "Show advanced settings" to see more.</p>}
    </div>
  );
}
