import type { EngineRecord, EngineSetting } from "@/lib/api";
import { GenericForm } from "@/kit/settings/GenericForm";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";
import { Button } from "@/kit/ui/button";

interface EnginePanelProps {
  engine: EngineRecord;
  open: boolean;
  settings?: EngineSetting[];
  draft: Record<string, string | number | boolean>;
  onClose: () => void;
  onAction: (action: string) => void | Promise<void>;
  onConfigChange: (key: string, value: string | number | boolean) => void;
  onSave: () => void | Promise<void>;
}

function tagOf(engine: EngineRecord): string { const marker = engine.id.indexOf("-b"); return marker > 0 ? engine.id.slice(marker + 1).split("-")[0] ?? engine.id : engine.id; }

export function EnginePanel({ engine, open, settings, draft, onClose, onAction, onConfigChange, onSave }: EnginePanelProps) {
  const tag = tagOf(engine);
  return <PropertyPanel kind="Engine" item={{ ...engine, name: engine.label }} status={engine.notCurrent ? engine.stateReason ?? "Not current" : "Ready"} open={open} onClose={onClose} actions={[{ label: "Start", onClick: () => onAction("start") }, { label: "Stop", onClick: () => onAction("stop"), destructive: true }, { label: "Restart", onClick: () => onAction("restart") }, ...(engine.notCurrent && engine.newestTag ? [{ label: "Update", onClick: () => onAction("update") }] : []), { label: "Make current", onClick: () => onAction(`current:${tag}`) }, { label: "Logs", onClick: () => onAction("logs") }]} tabs={{ overview: <div className="space-y-4 text-sm"><div><p className="font-medium">Version state</p><p className="text-muted-foreground">{engine.notCurrent ? `Not current: ${engine.stateReason}` : "Current"}</p></div><div><p className="font-medium">Running build</p><p className="text-muted-foreground">{engine.running ?? "Not running"}</p></div><div><p className="font-medium">Where</p><p className="text-muted-foreground">{engine.platform} · {engine.arch}</p></div><div><p className="font-medium">Health</p><p className="text-muted-foreground">{engine.state === "current" ? "Ready" : "Waiting for the current tag"}</p></div></div>, settings: <div className="space-y-4">{settings ? <><GenericForm settings={settings} values={draft} onChange={onConfigChange} /><Button className="w-full" onClick={() => void onSave()}>Save settings</Button></> : <p className="text-sm text-muted-foreground">Loading declared settings…</p>}</div>, insights: <div className="space-y-3 text-sm"><p className="font-medium">Usage and logs</p><p className="text-muted-foreground">Log tail and per-engine usage will appear here as the local feed fills.</p></div>}} />;
}
