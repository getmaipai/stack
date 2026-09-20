// The header's machine/stack selector and Lock MaiPai. Spec: "Machine
// stack selector reference" (machine-stack-selector.png). Replaces any
// avatar/profile/sign-out affordance; there is no other one in the app.
import { Link } from "react-router-dom";
import { getIcon } from "@/kit/icons";
import { api } from "@/lib/api";
import type { HardwareResponse, HealthItem } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { useRemoteStacks } from "@/hooks/use-remote-stacks";
import { severityDotClass } from "@/lib/health-severity";
import { Button } from "@/kit/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/kit/ui/dropdown-menu";

const MonitorIcon = getIcon("Monitor");
const LockIcon = getIcon("Lock");
const SettingsIcon = getIcon("Settings");
const FileTextIcon = getIcon("FileText");
const ChevronDownIcon = getIcon("ChevronDown");

const LOCKED_KEY = "maipai-stack:locked";

function healthSentence(items: HealthItem[]): string {
  return items.length === 0 ? "All systems healthy" : `${items.length} component${items.length === 1 ? "" : "s"} need attention`;
}

export function MachineSelector() {
  const hardware = useApiResource<HardwareResponse>("/stack/v1/hardware");
  const health = useApiResource<{ health: HealthItem[] }>("/stack/v1/health");
  const remoteStacks = useRemoteStacks();

  const name = hardware.data?.hardware?.computerName || "This computer";
  const dotClass = severityDotClass(health.data?.health ?? []);

  async function lock(): Promise<void> {
    try {
      await api.post("/stack/v1/operator/logout");
      // Set only on success: if the request fails the operator likely
      // stays signed in, so the reload lands back on the dashboard, not
      // the login card, and a marker set beforehand would stick around
      // in sessionStorage to mislabel a later, unrelated sign-out.
      sessionStorage.setItem(LOCKED_KEY, "1");
    } catch {
      // The reload in `finally` is the real fallback here; nothing else
      // in the UI needs to react to a failed logout call.
    } finally {
      // A hard reload, not a route change: the whole app's auth gate
      // (App.tsx's Gate) re-reads operator state from a fresh mount,
      // the same as a first load, rather than needing a second signal
      // threaded down to force it to re-check.
      window.location.assign("/");
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label={`Machine and stack: ${name}`} className="flex items-center gap-1.5">
          <MonitorIcon className="size-4" />
          <span aria-hidden="true" className={`size-2 rounded-full ${dotClass}`} />
          <span className="hidden max-w-32 truncate text-sm lg:inline">{name}</span>
          <ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Current stack</DropdownMenuLabel>
        {/* The violet-blue wash reads as "this is the one you're on"
            without the bright solid fill nav-main.tsx uses for an active
            row: machine-stack-selector.png shows the current stack as a
            highlighted row, not a filled one. */}
        <DropdownMenuItem disabled className="flex items-start gap-2 rounded-sm bg-[var(--primary)]/15 opacity-100 data-[disabled]:opacity-100">
          <MonitorIcon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">{hardware.data?.hardware?.osVersion ? `macOS ${hardware.data.hardware.osVersion} · ` : ""}{healthSentence(health.data?.health ?? [])}</span>
          </span>
          <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-full ${dotClass}`} />
        </DropdownMenuItem>
        {remoteStacks.length > 0 && (
          <>
            <DropdownMenuLabel>Switch stack</DropdownMenuLabel>
            {remoteStacks.map((stack) => (
              <DropdownMenuItem key={stack.id}>
                <MonitorIcon className="size-4" />
                <span className="flex-1 truncate">{stack.name}</span>
                <span className="text-xs text-muted-foreground">{stack.status === "online" ? "" : stack.status === "offline" ? "Offline" : "Connect"}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void lock()}>
          <LockIcon className="size-4" />
          Lock MaiPai
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings"><SettingsIcon className="size-4" />Settings</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/docs"><FileTextIcon className="size-4" />Help</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
