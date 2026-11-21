import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Badge } from "@maipai/ui/src/ui/badge";
import { Button } from "@maipai/ui/src/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@maipai/ui/src/ui/card";
import { StatusIndicator } from "@maipai/ui/src/ui/status";
import { Switch } from "@maipai/ui/src/ui/switch";
import { api } from "./api";
import type { Role } from "./api";
import type { Snapshot } from "./live";
import { movePriority, byPriority } from "./manage";
import { Failure, Loading, plainError } from "./shared";
import { roleKind, roleWord } from "./screens";
import type { Notify } from "./screens";

/** Screen 2: switch each feature on or off. A turned-off role is not started and says why. */
export function Features({ snap, refresh, notify }: { snap: Snapshot; refresh: () => void; notify: Notify }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!snap.loaded) return <Loading />;
  if (!snap.roles) return <Failure title="Could not reach the Stack" message={snap.error ?? "No answer yet."} />;
  async function toggle(role: Role, on: boolean) {
    setBusy(role.id);
    try {
      await api.putSettings({ [`stack.roles.${role.id}.enabled`]: on });
      notify(on ? `${role.label} is on.` : `${role.label} is off. Anything it was running has stopped.`);
    } catch (e) { notify(plainError(e, `${role.label} could not be changed. Try again.`)); }
    finally { setBusy(null); refresh(); }
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Turn a feature off and the Stack stops it, frees its memory and refuses its work with a clear reason. Turn it on and it starts the next time it is asked for.</p>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Features">
        {snap.roles.map((role) => {
          const why = role.plain_reason ?? role.reason ?? role.state.reason ?? null;
          const on = role.enabled !== false;
          return (
            <li key={role.id}>
              <Card className="h-full">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base"><StatusIndicator status={roleKind(role)} ping={false} />{role.label}</CardTitle>
                  <CardDescription>{roleWord(role)}</CardDescription>
                  <CardAction><Switch checked={on} disabled={busy === role.id} onCheckedChange={(v) => { void toggle(role, v); }} aria-label={`${role.label} on or off`} /></CardAction>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  <p>{role.model ? `Uses ${role.model.id}.` : "No model chosen yet."}</p>
                  {why && <p className="mt-1">{why}</p>}
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The priority list used on the Models screen: lower is served first when work waits for memory. */
export function PriorityList({ roles, refresh, notify }: { roles: Role[]; refresh: () => void; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  const ordered = byPriority(roles.map((r) => ({ ...r, priority: r.priority })));
  async function move(role: Role, dir: -1 | 1) {
    const changes = movePriority(roles.map((r) => ({ id: r.id, priority: r.priority })), role.id, dir);
    if (Object.keys(changes).length === 0) return;
    setBusy(true);
    try { await api.putSettings(changes); notify(`${role.label} moved ${dir < 0 ? "up" : "down"}.`); }
    catch (e) { notify(plainError(e, "The order could not be saved. Try again.")); }
    finally { setBusy(false); refresh(); }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Priority</CardTitle>
        <CardDescription>When memory is tight, features higher in this list are served first. Equal features keep the order requests arrived in.</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-1" aria-label="Priority order">
          {ordered.map((role, i) => (
            <li key={role.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5">
              <span className="w-5 text-sm text-muted-foreground">{i + 1}</span>
              <span className="me-auto text-sm">{role.label}</span>
              {role.enabled === false && <Badge variant="secondary">Off</Badge>}
              <Button size="icon-sm" variant="ghost" disabled={busy || i === 0} onClick={() => { void move(role, -1); }} aria-label={`Move ${role.label} up`}><ArrowUp aria-hidden="true" /></Button>
              <Button size="icon-sm" variant="ghost" disabled={busy || i === ordered.length - 1} onClick={() => { void move(role, 1); }} aria-label={`Move ${role.label} down`}><ArrowDown aria-hidden="true" /></Button>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
