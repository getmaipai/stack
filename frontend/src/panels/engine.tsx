import type { EngineRecord, EngineSetting } from "@/lib/api";
import { GenericForm } from "@/kit/settings/GenericForm";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";
import { KeyValueList } from "@/kit/blocks/property-panel/KeyValueList";
import { Button } from "@/kit/ui/button";
import { actionsFor } from "@/lib/actions";
import type { LiveDrive } from "@/lib/api";
import { driveForPath } from "@/lib/drives";

interface EnginePanelProps {
  engine: EngineRecord;
  open: boolean;
  settings?: EngineSetting[];
  draft: Record<string, string | number | boolean>;
  onClose: () => void;
  onAction: (action: string) => void | Promise<void>;
  onConfigChange: (key: string, value: string | number | boolean) => void;
  onSave: () => void | Promise<void>;
  drives?: LiveDrive[];
}

function tagOf(engine: EngineRecord): string { const marker = engine.id.indexOf("-b"); return marker > 0 ? engine.id.slice(marker + 1).split("-")[0] ?? engine.id : engine.id; }

export function EnginePanel({ engine, open, settings, draft, onClose, onAction, onConfigChange, onSave, drives }: EnginePanelProps) {
  const tag = tagOf(engine);
  const actions = actionsFor("engine", engine, (action) => onAction(action === "current" ? `current:${tag}` : action));
  const restart = actions.find((action) => action.label === "Restart")!;
  const logs = actions.find((action) => action.label === "Logs")!;
  const drive = driveForPath(engine.directory, drives);
  return <PropertyPanel kind="Engine" item={{ ...engine, name: engine.label }} status={engine.notCurrent ? engine.stateReason ?? "Not current" : "Ready"} facts={[{ label: "State", value: engine.notCurrent ? "Not current" : "Current" }, { label: "Platform", value: `${engine.platform} · ${engine.arch}` }, { label: "Build", value: tag }]} primaryActions={[logs, restart]} open={open} onClose={onClose} actions={actions} tabs={{ overview: <KeyValueList items={[{ label: "Kind", value: "Engine" }, { label: "Version state", value: engine.notCurrent ? engine.stateReason ?? "Not current" : "Current" }, { label: "Running build", value: engine.running ?? "Not running", copy: engine.running ?? undefined }, { label: "Where", value: engine.directory ?? "Not installed", copy: engine.directory ?? false }, { label: "Drive", value: drive ? `${drive.name}${drive.mounted ? "" : " (not mounted)"}` : "Not measured" }, { label: "Health", value: engine.state === "current" ? "Ready" : "Waiting for the current tag" }]} />, settings: <div className="space-y-4">{settings ? <><GenericForm settings={settings} values={draft} onChange={onConfigChange} /><Button className="w-full" onClick={() => void onSave()}>Save settings</Button></> : <p className="text-sm text-muted-foreground">Loading declared settings…</p>}</div>, insights: <div className="space-y-3 text-sm"><p className="font-medium">Usage and logs</p><p className="text-muted-foreground">Log tail and per-engine usage will appear here as the local feed fills.</p></div>}} />;
}
