import { useMemo } from "react";
import type { EngineSetting } from "@/lib/api";
import { Checkbox } from "@/kit/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/kit/ui/collapsible";
import { Input } from "@/kit/ui/input";
import { Label } from "@/kit/ui/label";

export interface GenericFormProps {
  settings: EngineSetting[];
  values: Record<string, string | number | boolean>;
  onChange: (key: string, value: string | number | boolean) => void;
}

function SettingControl({ setting, value, onChange }: { setting: EngineSetting; value: string | number | boolean; onChange: (value: string | number | boolean) => void }) {
  if (setting.type === "boolean") return <Checkbox aria-label={setting.label} checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked === true)} />;
  return <Input aria-label={setting.label} type={setting.type === "number" ? "number" : "text"} value={String(value)} onChange={(event) => onChange(setting.type === "number" ? Number(event.target.value) : event.target.value)} />;
}

export function GenericForm({ settings, values, onChange }: GenericFormProps) {
  const groups = useMemo(() => {
    const basic = settings.filter((setting) => setting.disclosure === "basic");
    const advanced = settings.filter((setting) => setting.disclosure === "advanced");
    const developer = settings.filter((setting) => setting.disclosure === "developer");
    return { basic, advanced, developer };
  }, [settings]);
  const render = (setting: EngineSetting) => <div className="space-y-2" key={setting.key}><Label htmlFor={`setting-${setting.key}`}>{setting.label}{setting.needsRestart && <span className="text-xs font-normal text-muted-foreground"> · restart</span>}</Label><SettingControl setting={setting} value={values[setting.key] ?? setting.inEffect} onChange={(value) => onChange(setting.key, value)} /><p className="text-xs text-muted-foreground">{setting.help}</p></div>;
  return <div className="space-y-6" data-testid="generic-engine-form">{groups.basic.map(render)}{groups.advanced.length > 0 && <Collapsible><CollapsibleTrigger className="text-sm font-medium">Advanced settings</CollapsibleTrigger><CollapsibleContent className="mt-4 space-y-5">{groups.advanced.map(render)}</CollapsibleContent></Collapsible>}{groups.developer.length > 0 && <Collapsible><CollapsibleTrigger className="text-sm font-medium">Developer settings</CollapsibleTrigger><CollapsibleContent className="mt-4 space-y-5">{groups.developer.map(render)}</CollapsibleContent></Collapsible>}</div>;
}
