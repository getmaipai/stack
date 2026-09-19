export type StackSectionId = "general" | "memory" | "updates" | "backups" | "network" | "channels" | "alerts" | "storage" | "maintenance" | "engines" | "hardware" | "diagnostics" | "reset" | "helper";
export interface StackSection { id: StackSectionId; title: string; icon: string; order: number; itemId?: string; computer?: boolean; }

export const STACK_SETTING_SECTIONS: StackSection[] = [
  { id: "general", title: "General", icon: "Settings", order: 10 },
  { id: "memory", title: "Memory", icon: "Gauge", order: 15 },
  { id: "updates", title: "Updates", icon: "RefreshCw", order: 20 },
  { id: "backups", title: "Backups", icon: "UploadCloud", order: 30, itemId: "STACK-11" },
  { id: "network", title: "Network and access", icon: "ShieldCheck", order: 40 },
  { id: "channels", title: "Alert channels", icon: "Bell", order: 50 },
  { id: "alerts", title: "Alerts", icon: "BellRing", order: 55 },
  { id: "storage", title: "Storage", icon: "Database", order: 60 },
  { id: "maintenance", title: "Maintenance", icon: "Wrench", order: 70, itemId: "STACK-22" },
  { id: "engines", title: "Engines", icon: "Cpu", order: 80 },
  { id: "hardware", title: "Hardware", icon: "Monitor", order: 90, computer: true },
  { id: "diagnostics", title: "Diagnostics", icon: "FileText", order: 100, computer: true },
  { id: "reset", title: "Reset", icon: "RotateCcw", order: 110, computer: true },
  { id: "helper", title: "Helper", icon: "MessageCircle", order: 120 },
];
