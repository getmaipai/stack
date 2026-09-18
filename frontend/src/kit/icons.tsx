// The icon registry is the single permitted boundary for the lucide package.
// eslint-disable-next-line no-restricted-imports
import { Activity, ArrowDown, ArrowUp, Bell, Bot, Box, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Cpu, Database, Download, ExternalLink, FileKey2, FileText, Filter, Gauge, History, Info, KeyRound, LayoutDashboard, LayoutList, LoaderCircle, Lock, LogOut, MessageSquare, Mic, Monitor, Moon, Play, RefreshCw, RotateCcw, Search, Send, Server, Settings, Settings2, ShieldCheck, SlidersHorizontal, Square, Sun, UploadCloud, Volume2, Wrench } from "lucide-react";
// eslint-disable-next-line no-restricted-imports
import type { LucideIcon } from "lucide-react";
export type Icon = LucideIcon;
export type IconName = keyof typeof icons;
export const icons = { Activity, ArrowDown, ArrowUp, Bell, Bot, Box, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Cpu, Database, Download, ExternalLink, FileKey2, FileText, Filter, Gauge, History, Info, KeyRound, LayoutDashboard, LayoutList, LoaderCircle, Lock, LogOut, MessageSquare, Mic, Monitor, Moon, Play, RefreshCw, RotateCcw, Search, Send, Server, Settings, Settings2, ShieldCheck, SlidersHorizontal, Square, Sun, UploadCloud, Volume2, Wrench } as const;
export function getIcon(name: keyof typeof icons): LucideIcon { return icons[name]; }
