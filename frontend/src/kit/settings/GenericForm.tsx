import { useMemo } from "react";
import type { EngineSetting } from "@/lib/api";
import { getIcon } from "@/kit/icons";
import { Badge } from "@/kit/ui/badge";
import { Button } from "@/kit/ui/button";
import { Checkbox } from "@/kit/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/kit/ui/collapsible";
import { Input } from "@/kit/ui/input";
import { Label } from "@/kit/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/kit/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/kit/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/kit/ui/toggle-group";

type SettingValue = string | number | boolean;
const Info = getIcon("Info"); const Check = getIcon("Check");

export interface GenericFormProps {
  settings: EngineSetting[];
  values: Record<string, SettingValue>;
  onChange: (key: string, value: SettingValue) => void;
  disabled?: boolean;
  testId?: string;
}

function sameValue(left: SettingValue, right: SettingValue): boolean { return left === right; }

function SettingControl({ setting, value, onChange, disabled }: { setting: EngineSetting; value: SettingValue; onChange: (value: SettingValue) => void; disabled?: boolean }) {
  if (setting.type === "boolean") return <Checkbox id={`setting-${setting.key}`} aria-label={setting.label} checked={Boolean(value)} disabled={disabled} onCheckedChange={(checked) => onChange(checked === true)} />;
  if (setting.type === "enum" && (setting.options?.length ?? 0) <= 3) return <ToggleGroup disabled={disabled} type="single" variant="outline" value={String(value)} onValueChange={(next) => { if (next) onChange(next); }} aria-label={setting.label}>{(setting.options ?? []).map((option) => <ToggleGroupItem key={option.value} value={option.value} aria-label={option.label}>{option.label}</ToggleGroupItem>)}</ToggleGroup>;
  if (setting.type === "enum") return <Select disabled={disabled} value={String(value)} onValueChange={onChange}><SelectTrigger id={`setting-${setting.key}`} aria-label={setting.label}><SelectValue /></SelectTrigger><SelectContent>{(setting.options ?? []).map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>;
  return <Input disabled={disabled} id={`setting-${setting.key}`} aria-label={setting.label} type={setting.type === "number" ? "number" : setting.type === "secret" || setting.type === "password" ? "password" : "text"} min={setting.range?.min} max={setting.range?.max} value={String(value)} onChange={(event) => onChange(setting.type === "number" ? Number(event.target.value) : event.target.value)} />;
}

function SettingRow({ setting, value, onChange, disabled }: { setting: EngineSetting; value: SettingValue; onChange: (value: SettingValue) => void; disabled?: boolean }) {
  const pending = !sameValue(value, setting.inEffect);
  return <div className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-5 border-t py-4 first:border-t-0 ${disabled ? "opacity-50" : ""}`} data-testid={`setting-row-${setting.key}`}><div className="min-w-0"><div className="flex items-center gap-1.5"><Label htmlFor={`setting-${setting.key}`}>{setting.label}</Label><Popover><PopoverTrigger asChild><Button disabled={disabled} type="button" size="icon-xs" variant="ghost" aria-label={`Explain ${setting.label}`}><Info /></Button></PopoverTrigger><PopoverContent align="start" className="space-y-2 text-sm"><p>{setting.help}</p>{setting.needsRestart && <p className="text-muted-foreground">Takes effect after a restart.</p>}</PopoverContent></Popover>{pending && !disabled && <Badge variant="outline">pending</Badge>}{!pending && !disabled && <Check className="size-4 text-emerald-600" aria-label="Saved" />}</div></div><div className="min-w-0"><SettingControl setting={setting} value={value} disabled={disabled} onChange={onChange} /></div></div>;
}

function DisclosureRows({ label, settings, values, onChange, disabled }: { label: string; settings: EngineSetting[]; values: Record<string, SettingValue>; onChange: GenericFormProps["onChange"]; disabled?: boolean }) {
  if (settings.length === 0) return null;
  return <Collapsible><CollapsibleTrigger asChild><Button disabled={disabled} type="button" variant="link" className="h-auto px-0 text-sm">{label}</Button></CollapsibleTrigger><CollapsibleContent className="mt-1"><div>{settings.map((setting) => <SettingRow disabled={disabled} key={setting.key} setting={setting} value={values[setting.key] ?? setting.pending ?? setting.inEffect} onChange={(value) => onChange(setting.key, value)} />)}</div></CollapsibleContent></Collapsible>;
}

function SettingsGroup({ title, settings, values, onChange, disabled }: { title: string; settings: EngineSetting[]; values: Record<string, SettingValue>; onChange: GenericFormProps["onChange"]; disabled?: boolean }) {
  const basic = settings.filter((setting) => setting.disclosure === "basic");
  const advanced = settings.filter((setting) => setting.disclosure === "advanced");
  const developer = settings.filter((setting) => setting.disclosure === "developer");
  return <section className="space-y-1" data-testid={`settings-group-${title}`}><h3 className="text-sm font-semibold">{title}</h3><div>{basic.map((setting) => <SettingRow disabled={disabled} key={setting.key} setting={setting} value={values[setting.key] ?? setting.pending ?? setting.inEffect} onChange={(value) => onChange(setting.key, value)} />)}</div><div className="flex flex-wrap gap-x-4 gap-y-1 pt-2"><DisclosureRows disabled={disabled} label="Show advanced" settings={advanced} values={values} onChange={onChange} /><DisclosureRows disabled={disabled} label="Show developer settings" settings={developer} values={values} onChange={onChange} /></div></section>;
}

export function GenericForm({ settings, values, onChange, disabled, testId = "generic-engine-form" }: GenericFormProps) {
  const groups = useMemo(() => {
    const grouped = new Map<string, EngineSetting[]>();
    for (const setting of settings) { const title = setting.group ?? "Settings"; grouped.set(title, [...(grouped.get(title) ?? []), setting]); }
    return [...grouped.entries()];
  }, [settings]);
  const hasPending = settings.some((setting) => !sameValue(values[setting.key] ?? setting.pending ?? setting.inEffect, setting.inEffect));
  return <div className="space-y-8" data-testid={testId}>{groups.map(([title, group]) => <SettingsGroup disabled={disabled} key={title} title={title} settings={group} values={values} onChange={onChange} />)}{hasPending && !disabled && <p className="border-t pt-4 text-sm text-muted-foreground">Restart to apply pending settings.</p>}</div>;
}
