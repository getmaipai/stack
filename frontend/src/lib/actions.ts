import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";
import { sentenceFor } from "@/lib/unavailable";

export type ThingKind = "engine" | "model" | "detected" | "group" | "client";
export type ActionHandler = (action: string) => void | Promise<void>;

export function actionsFor(kind: ThingKind, item: { loaded?: boolean; current?: boolean; notCurrent?: boolean; newestTag?: string | null; count?: number; name?: string; qualified?: boolean; installed?: boolean; running?: string | null }, onAction: ActionHandler, surface: "panel" | "row" = "panel"): PropertyAction[] {
  const qualified = item.qualified ?? true;
  const engineUpdateSentence = sentenceFor("engine-update")!;
  const detectedSentence = sentenceFor("detected-start")!;
  const detectedRemoveSentence = sentenceFor("detected-remove")!;
  const modelUnqualifiedSentence = sentenceFor("model-load-unqualified")!;
  const modelInstallSentence = sentenceFor("model-install-unresolved")!;
  if (kind === "engine") return [
    ...(surface === "row" && item.running ? [{ label: "Stop", icon: "Square", onClick: () => onAction("stop"), destructive: true, disabled: !qualified, sentence: !qualified ? detectedSentence : undefined } as PropertyAction] : []),
    ...(surface === "row" && item.installed && !item.running ? [{ label: "Start", icon: "Play", onClick: () => onAction("start"), disabled: !qualified, sentence: !qualified ? detectedSentence : undefined } as PropertyAction] : []),
    ...(surface === "panel" ? [{ label: "Start", icon: "Play", onClick: () => onAction("start"), disabled: !qualified, sentence: !qualified ? detectedSentence : undefined } as PropertyAction, { label: "Stop", icon: "Square", onClick: () => onAction("stop"), destructive: true, disabled: !qualified, sentence: !qualified ? detectedSentence : undefined } as PropertyAction] : []),
    { label: "Restart", icon: "RefreshCw", onClick: () => onAction("restart"), disabled: !qualified, sentence: !qualified ? detectedSentence : undefined },
    ...(item.notCurrent && item.newestTag ? [{ label: "Update", icon: "UploadCloud", onClick: () => onAction("update"), disabled: true, sentence: engineUpdateSentence } as PropertyAction] : []),
    { label: "Make current", icon: "Check", onClick: () => onAction("current") },
    { label: "Logs", icon: "FileText", onClick: () => onAction("logs") },
    ...(surface === "row" ? [{ label: "Forget", icon: "Square", onClick: () => onAction("forget"), destructive: true, disabled: !qualified, sentence: !qualified ? detectedRemoveSentence : undefined } as PropertyAction] : []),
  ];
  if (kind === "model") return [
    { label: surface === "panel" ? "Load" : item.loaded ? "Unload" : "Load", icon: surface === "panel" || !item.loaded ? "Download" : "UploadCloud", onClick: () => onAction(surface === "panel" || !item.loaded ? "load" : "unload"), disabled: !qualified, sentence: !qualified ? modelUnqualifiedSentence : undefined },
    ...(surface === "panel" ? [{ label: "Unload", icon: "UploadCloud", onClick: () => onAction("unload"), disabled: !qualified, sentence: !qualified ? modelUnqualifiedSentence : undefined } as PropertyAction] : []),
    { label: "Pin", icon: "KeyRound", onClick: () => onAction("pin"), disabled: !qualified, sentence: !qualified ? modelUnqualifiedSentence : undefined },
    ...(surface === "row" ? [{ label: "Rename", icon: "Pencil", onClick: () => onAction("rename") } as PropertyAction, { label: "Move to group", icon: "Folder", onClick: () => onAction("move") } as PropertyAction] : []),
    { label: "Update", icon: "RefreshCw", onClick: () => onAction("update"), disabled: true, sentence: modelInstallSentence },
    { label: "Remove", icon: "Square", onClick: () => onAction("remove"), destructive: true },
  ];
  if (kind === "detected") return [{ label: "Adopt", icon: "Check", onClick: () => onAction("adopt") }, { label: "Forget", icon: "Square", onClick: () => onAction("forget"), destructive: true, disabled: !qualified, sentence: !qualified ? detectedRemoveSentence : undefined }];
  if (kind === "group") return surface === "panel" ? [{ label: "Load all", icon: "Download", onClick: () => onAction("load") }, { label: "Unload all", icon: "UploadCloud", onClick: () => onAction("unload") }, { label: "Pin", icon: "KeyRound", onClick: () => onAction("pin") }, { label: "Unpin", icon: "KeyRound", onClick: () => onAction("unpin") }, { label: "Check updates", icon: "RefreshCw", onClick: () => onAction("checkUpdates") }, { label: "Move", icon: "Settings", onClick: () => onAction("move") }, { label: "Remove", icon: "Square", onClick: () => onAction("remove"), destructive: true }] : [{ label: "Rename", icon: "Pencil", onClick: () => onAction("rename") }, { label: "Move", icon: "Folder", onClick: () => onAction("move") }, { label: "Load all", icon: "Download", onClick: () => onAction("load") }, { label: "Unload all", icon: "UploadCloud", onClick: () => onAction("unload") }, { label: "Remove group", icon: "Square", onClick: () => onAction("remove"), destructive: true }];
  return [{ label: "Rotate key", icon: "KeyRound", onClick: () => onAction("rotate") }, { label: "Revoke", icon: "Square", onClick: () => onAction("revoke"), destructive: true }];
}
