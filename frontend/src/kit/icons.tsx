// The icon registry is the single permitted boundary for the lucide package.
// eslint-disable-next-line no-restricted-imports
import { Bell, Bot, Box, Check, Copy, Cpu, ExternalLink, FileKey2, Gauge, KeyRound, LayoutDashboard, LoaderCircle, RefreshCw, Search, Server, Settings, ShieldCheck, SlidersHorizontal, UploadCloud } from "lucide-react";
// eslint-disable-next-line no-restricted-imports
import type { LucideIcon } from "lucide-react";
export type Icon = LucideIcon;
export const icons = { Bell, Bot, Box, Check, Copy, Cpu, ExternalLink, FileKey2, Gauge, KeyRound, LayoutDashboard, LoaderCircle, RefreshCw, Search, Server, Settings, ShieldCheck, SlidersHorizontal, UploadCloud } as const;
export function getIcon(name: keyof typeof icons): LucideIcon { return icons[name]; }
