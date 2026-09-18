// The icon registry is the single permitted boundary for the lucide package.
// eslint-disable-next-line no-restricted-imports
import { ArrowDown, ArrowUp, Bell, Bot, Box, Check, ChevronDown, ChevronRight, Copy, Cpu, ExternalLink, FileKey2, Gauge, KeyRound, LayoutDashboard, LoaderCircle, Lock, LogOut, MessageSquare, Mic, RefreshCw, Search, Send, Server, Settings, ShieldCheck, SlidersHorizontal, Square, UploadCloud, Volume2 } from "lucide-react";
// eslint-disable-next-line no-restricted-imports
import type { LucideIcon } from "lucide-react";
export type Icon = LucideIcon;
export const icons = { ArrowDown, ArrowUp, Bell, Bot, Box, Check, ChevronDown, ChevronRight, Copy, Cpu, ExternalLink, FileKey2, Gauge, KeyRound, LayoutDashboard, LoaderCircle, Lock, LogOut, MessageSquare, Mic, RefreshCw, Search, Send, Server, Settings, ShieldCheck, SlidersHorizontal, Square, UploadCloud, Volume2 } as const;
export function getIcon(name: keyof typeof icons): LucideIcon { return icons[name]; }
