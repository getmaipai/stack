import { useEffect, useState } from "react";
import type { EngineSetting } from "@/lib/api";
import { api } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { GenericForm } from "@/kit/settings/GenericForm";
import { Button } from "@/kit/ui/button";
import type { SectionFrameComponent } from "@/pages/DashboardShell";

export function SettingsPage({ Frame }: { Frame: SectionFrameComponent }) {
  const settings = useApiResource<{ settings: EngineSetting[] }>("/stack/v1/settings");
  const [draft, setDraft] = useState<Record<string, string | number | boolean>>({});
  useEffect(() => { if (settings.data) setDraft(Object.fromEntries(settings.data.settings.map((setting) => [setting.key, setting.pending ?? setting.inEffect]))); }, [settings.data]);
  async function save(): Promise<void> { await api.put("/stack/v1/settings", draft); await settings.refetch(); }
  return <Frame title="Settings" description="The few declared settings for this local Stack."><div className="max-w-3xl space-y-5">{settings.loading && <p className="text-sm text-muted-foreground">Loading declared settings…</p>}{settings.error && <p className="text-sm text-destructive">Settings could not be loaded.</p>}{settings.data && <><GenericForm settings={settings.data.settings} values={draft} onChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))} /><Button onClick={() => void save()}>Save settings</Button></>}</div></Frame>;
}
