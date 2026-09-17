// The icon registry is the single permitted boundary for the lucide package.
// eslint-disable-next-line no-restricted-imports
import { ArrowDown, Bell, Bot, Box, Check, Copy, Cpu, ExternalLink, FileKey2, Gauge, KeyRound, LayoutDashboard, LoaderCircle, Lock, LogOut, Mic, RefreshCw, Search, Send, Server, Settings, ShieldCheck, SlidersHorizontal, Square, UploadCloud, Volume2 } from "lucide-react";
// eslint-disable-next-line no-restricted-imports
import type { LucideIcon } from "lucide-react";
export type Icon = LucideIcon;
export const icons = { ArrowDown, Bell, Bot, Box, Check, Copy, Cpu, ExternalLink, FileKey2, Gauge, KeyRound, LayoutDashboard, LoaderCircle, Lock, LogOut, Mic, RefreshCw, Search, Send, Server, Settings, ShieldCheck, SlidersHorizontal, Square, UploadCloud, Volume2 } as const;
export function getIcon(name: keyof typeof icons): LucideIcon { return icons[name]; }
