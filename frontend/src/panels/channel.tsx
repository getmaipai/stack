import type { ReactNode } from "react";
import type { EngineSetting } from "@/lib/api";
import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";
import { KeyValueList } from "@/kit/blocks/property-panel/KeyValueList";
export interface ChannelPanelResult { actions: PropertyAction[]; primaryActions: [PropertyAction, PropertyAction]; facts: Array<{ label: string; value: ReactNode }>; overview: ReactNode; settings: EngineSetting[] }
export function channelPanel(type: string, verified: string, onAction: (action: string) => void): ChannelPanelResult {
  const test: PropertyAction = { label: "Send a test", icon: "Send", onClick: () => onAction("test") };
  const edit: PropertyAction = { label: "Edit", icon: "Settings", onClick: () => onAction("edit") };
  const settings: EngineSetting[] = type === "telegram" ? [
    { key: "botToken", type: "secret", default: "", inEffect: "", pending: null, group: "Telegram", label: "Bot token", help: "Stored encrypted and never shown again after saving.", disclosure: "basic", needsRestart: false },
    { key: "chatId", type: "text", default: "", inEffect: "", pending: null, group: "Telegram", label: "Chat ID", help: "The Telegram chat that receives alerts.", disclosure: "basic", needsRestart: false },
  ] : [
    { key: "serverUrl", type: "text", default: "https://ntfy.sh", inEffect: "https://ntfy.sh", pending: null, group: "ntfy", label: "Server URL", help: "The ntfy server that owns the topic.", disclosure: "basic", needsRestart: false },
    { key: "topic", type: "text", default: "", inEffect: "", pending: null, group: "ntfy", label: "Topic", help: "The topic to publish alerts to.", disclosure: "basic", needsRestart: false },
    { key: "accessToken", type: "password", default: "", inEffect: "", pending: null, group: "ntfy", label: "Access token", help: "Optional token, stored encrypted and never prefilled.", disclosure: "advanced", needsRestart: false },
  ];
  return { actions: [test, edit], primaryActions: [test, edit], facts: [{ label: "Type", value: type }, { label: "Verified", value: verified }, { label: "Scope", value: "Local" }], overview: <KeyValueList items={[{ label: "Kind", value: "Alert channel" }, { label: "Type", value: type }, { label: "Verified", value: verified }]} />, settings };
}
