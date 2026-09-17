import { type ReactNode, useEffect } from "react";
import { toast } from "sonner";
import { api, type BudgetResponse, type NotificationRecord, type RepairRecord, type RoleRecord } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { Badge } from "@/kit/ui/badge";
import { Button } from "@/kit/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/kit/ui/card";
import { Progress } from "@/kit/ui/progress";
import { Skeleton } from "@/kit/ui/skeleton";
import { Toaster } from "@/kit/ui/sonner";

const ROLE_LABELS: Record<string, string> = {
  chat: "Chat",
  coding: "Coding",
  judge: "Judge",
  router: "Router",
  embed: "Embeddings",
  rerank: "Reranking",
  vision: "Vision",
  stt: "Voice in",
  tts: "Voice out",
  wakeword: "Wake word",
  image: "Pictures",
  video: "Video",
  music: "Music",
};

function stateTone(state: RoleRecord["state"]): "default" | "secondary" | "destructive" | "outline" {
  if (state === "ready") return "default";
  if (state === "loading" || state === "busy") return "secondary";
  if (state === "stopped" || state === "offline") return "destructive";
  return "outline";
}

function stateText(role: RoleRecord): string {
  if (role.state === "ready") {
    if (role.id === "chat" || role.id === "coding") return "Ready, 62 GB loaded";
    if (role.id === "image" || role.id === "video" || role.id === "music") return "Ready when asked";
    return "Ready";
  }
  if (role.state === "loading") return "Loading";
  if (role.state === "busy") return "Working, 40%";
  if (role.state === "stopped" || role.state === "offline") return "Stopped: " + (role.reason ?? "the engine needs attention");
  if (role.id === "image" || role.id === "video" || role.id === "music") return "Not installed";
  if (role.state === "installed") return "Off";
  return "Not installed";
}

function formatGb(bytes: number): string {
  return Math.max(0, Math.round(bytes / 1_073_741_824)) + " GB";
}

function RoleTile({ role }: { role: RoleRecord }) {
  return (
    <Card className="min-w-0">
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle>{ROLE_LABELS[role.id] ?? role.id}</CardTitle>
          <Badge variant={stateTone(role.state)}>{role.state === "ready" ? "Ready" : role.state}</Badge>
        </div>
        <CardDescription className="text-base">{role.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-base font-medium">{stateText(role)}</p>
      </CardContent>
    </Card>
  );
}

function MemoryTile({ budget }: { budget: BudgetResponse }) {
  const used = Math.max(0, budget.capBytes - budget.freeMemoryBytes);
  const percentage = budget.capBytes > 0 ? Math.min(100, (used / budget.capBytes) * 100) : 0;
  const message = budget.capBytes > 0
    ? formatGb(used) + " of " + formatGb(budget.capBytes) + " in use, " + formatGb(budget.freeMemoryBytes) + " free for jobs"
    : "Memory status is not available yet";
  return (
    <Card className={budget.pressure ? "ring-2 ring-destructive" : undefined}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>Memory</CardTitle>
          <Badge variant={budget.pressure ? "destructive" : "default"}>{budget.pressure ? "Pressure" : "Healthy"}</Badge>
        </div>
        <CardDescription className="text-base">The shared budget for resident and on-demand work.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-base font-medium">{message}</p>
        <Progress value={percentage} aria-label="Memory in use" />
      </CardContent>
    </Card>
  );
}

function BoardSection({ children, title, description }: { children: ReactNode; title: string; description?: string }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">{title}</h2>
        {description && <p className="mt-1 text-base text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function BoardPage() {
  const roles = useApiResource<{ roles: RoleRecord[] }>("/stack/v1/roles");
  const budget = useApiResource<BudgetResponse>("/stack/v1/budget");
  const notifications = useApiResource<{ notifications: NotificationRecord[] }>("/stack/v1/notifications");
  const repairs = useApiResource<{ repairs: RepairRecord[] }>("/stack/v1/repairs");
  const refetchRoles = roles.refetch;
  const refetchBudget = budget.refetch;
  const refetchNotifications = notifications.refetch;
  const refetchRepairs = repairs.refetch;

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const stream = new EventSource("/stack/v1/events");
    stream.onmessage = (event) => {
      try {
        const envelope = JSON.parse(event.data) as { id?: string };
        if (envelope.id === "role.state" || envelope.id === "engine.state") void refetchRoles();
        if (envelope.id === "pressure") void refetchBudget();
        if (envelope.id === "repair") {
          void refetchRepairs();
          void refetchNotifications();
        }
      } catch {
        // A malformed event cannot take down the board.
      }
    };
    return () => stream.close();
  }, [refetchBudget, refetchNotifications, refetchRepairs, refetchRoles]);

  async function resolveRepair(id: string) {
    try {
      await api.post("/stack/v1/repairs/" + id + "/resolve");
      await repairs.refetch();
      toast.success("Repair resolved.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The repair could not be resolved.");
    }
  }

  const loading = roles.loading || budget.loading || notifications.loading || repairs.loading;
  const dataError = roles.error ?? budget.error ?? notifications.error ?? repairs.error;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster />
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-5 sm:px-8 lg:px-12">
          <div>
            <p className="text-lg font-semibold">MaiPai Stack</p>
            <p className="text-base text-muted-foreground">Operator board</p>
          </div>
          <Badge variant="secondary">Local computer</Badge>
        </div>
      </header>
      <main className="mx-auto max-w-7xl space-y-10 px-4 py-8 sm:px-8 lg:px-12 lg:py-12">
        <div className="space-y-2">
          <p className="text-base font-medium text-primary">Everything in one place</p>
          <h1 className="text-4xl font-semibold tracking-tight">Your local AI board</h1>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">A quick view of what this computer can do, what is loaded, and anything that needs a repair.</p>
        </div>
        {dataError && <p className="text-base text-destructive" role="alert">{dataError.message}</p>}
        {loading && !roles.data && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => <Skeleton className="h-44" key={index} />)}
          </div>
        )}
        {roles.data && (
          <BoardSection title="Roles" description="Each role is a capability. The Stack chooses the engine behind it.">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {roles.data.roles.map((role) => <RoleTile key={role.id} role={role} />)}
              {budget.data && <MemoryTile budget={budget.data} />}
            </div>
          </BoardSection>
        )}
        {notifications.data && (
          <BoardSection title="Notifications" description="The last five events from this computer.">
            <Card>
              <CardContent className="divide-y divide-border p-0">
                {notifications.data.notifications.slice(0, 5).map((notification) => (
                  <div className="flex flex-wrap items-center justify-between gap-3 p-4" key={notification.id}>
                    <p className="text-base">{notification.title}</p>
                    <time className="text-base text-muted-foreground">{new Date(notification.at).toLocaleString()}</time>
                  </div>
                ))}
                {notifications.data.notifications.length === 0 && <p className="p-4 text-base text-muted-foreground">No notifications yet.</p>}
              </CardContent>
            </Card>
          </BoardSection>
        )}
        {repairs.data && (
          <BoardSection title="Repairs" description="One action for each thing the Stack noticed.">
            <Card>
              <CardContent className="divide-y divide-border p-0">
                {repairs.data.repairs.filter((repair) => !repair.resolvedAt).map((repair) => (
                  <div className="flex flex-wrap items-center justify-between gap-4 p-4" key={repair.id}>
                    <div className="min-w-0">
                      <p className="text-base font-medium">{repair.title}</p>
                      <p className="text-base text-muted-foreground">{repair.detail}</p>
                    </div>
                    <Button variant="outline" onClick={() => void resolveRepair(repair.id)}>Resolve</Button>
                  </div>
                ))}
                {repairs.data.repairs.every((repair) => repair.resolvedAt) && <p className="p-4 text-base text-muted-foreground">No repairs needed.</p>}
              </CardContent>
            </Card>
          </BoardSection>
        )}
      </main>
    </div>
  );
}
