import { useState } from "react";
import { Download } from "lucide-react";
import { Badge } from "@maipai/ui/src/ui/badge";
import { Button } from "@maipai/ui/src/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@maipai/ui/src/ui/card";
import { StatusIndicator } from "@maipai/ui/src/ui/status";
import { api } from "./api";
import type { CheckResult, SettingsDoc } from "./api";
import { ago } from "./format";
import { readinessWord, rebootAllowed } from "./manage";
import { ConfirmButton, Failure, plainError, useLoad } from "./shared";
import type { Notify } from "./screens";

/** Screen 10: diagnostics, readiness check, restart the Stack, reboot the computer (only when the setting allows it). */
export function Tools({ roleLabels, notify }: { roleLabels: Record<string, string>; notify: Notify }) {
  const settings = useLoad<SettingsDoc>(() => api.settings());
  const latest = useLoad(() => api.latestReadiness());
  const [result, setResult] = useState<CheckResult | null>(null);
  const [running, setRunning] = useState(false);
  const shown: (CheckResult & { stale?: boolean; staleReason?: string }) | null = result ?? latest.data?.latest ?? null;

  async function readiness() {
    setRunning(true);
    try { const r = await api.readiness(); setResult(r); notify(r.ok ? "Everything answered." : "Something did not answer. See the list below."); }
    catch (e) { notify(plainError(e, "The readiness check could not run. Try again.")); }
    finally { setRunning(false); }
  }
  async function restart() {
    try { await api.restartStack(); notify("The Stack is restarting. This page reconnects by itself."); }
    catch (e) { notify(plainError(e, "The Stack could not be restarted. Nothing was changed.")); }
  }
  async function reboot() {
    try { await api.rebootHost(); notify("The computer is restarting. This page comes back when it is up."); }
    catch (e) { notify(plainError(e, "The computer could not be restarted. Nothing was changed.")); }
  }
  const canReboot = rebootAllowed(settings.data);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Readiness check</CardTitle>
          <CardDescription>Sends one small real request through each feature and checks that they fit in memory together. It can take a minute and may load models.</CardDescription>
          <CardAction><ConfirmButton variant="default" disabled={running} label={running ? "Checking" : "Run the check"} title="Run the readiness check?" confirm="Run" text="Each turned-on feature gets one small request. Models that are not loaded will load, which uses memory and takes a moment." onConfirm={readiness} /></CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {latest.error && !shown && <Failure title="The last check could not be read" message={latest.error} />}
          {!shown && !latest.error && <p className="text-muted-foreground">No check has run yet.</p>}
          {shown && (
            <>
              <p className="flex items-center gap-2 font-medium"><StatusIndicator status={shown.ok ? "online" : "offline"} ping={false} />{shown.results.length === 0 ? "Nothing could be checked" : shown.ok ? "Everything answered" : "Something did not answer"}<span className="text-xs font-normal text-muted-foreground">{ago(shown.at)}</span></p>
              {shown.stale && <p className="text-muted-foreground">{shown.staleReason ?? "This result is older than the current setup. Run the check again."}</p>}
              <ul className="flex flex-col gap-1" aria-label="Check results">
                {shown.results.map((r) => (
                  <li key={r.role} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5">
                    <span className="me-auto">{roleLabels[r.role] ?? r.role}</span>
                    <Badge variant={r.ok || r.skipped ? "secondary" : "destructive"}>{readinessWord(r.ok, r.skipped)}</Badge>
                    {!r.skipped && <span className="text-xs text-muted-foreground">{r.ms} ms</span>}
                    {r.reason && <span className="w-full text-xs text-muted-foreground">{r.reason}</span>}
                  </li>
                ))}
              </ul>
              {shown.fitTogether && <p className="text-muted-foreground">{shown.fitTogether.ok ? "They fit in memory together." : shown.fitTogether.reason ?? "They do not all fit in memory together."}</p>}
              {shown.reason && !shown.ok && <p className="text-muted-foreground">{shown.reason}</p>}
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Diagnostics</CardTitle><CardDescription>A zip with the log tail, health, hardware, settings and versions, with secrets removed. Nothing is sent anywhere.</CardDescription></CardHeader>
        <CardContent><Button asChild variant="outline"><a href="/stack/v1/diagnostics" download="maipai-stack-diagnostics.zip"><Download aria-hidden="true" />Download diagnostics</a></Button></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Restart the Stack</CardTitle><CardDescription>Stops the engines, restarts the service and starts them again when asked. Requests in flight are finished first.</CardDescription></CardHeader>
        <CardContent><ConfirmButton label="Restart the Stack" title="Restart the Stack?" confirm="Restart" text="Engines stop and start again. Anything using the Stack waits a few seconds. This page reconnects by itself." onConfirm={restart} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Restart the computer</CardTitle><CardDescription>{canReboot ? "Restarts the whole computer." : "Switched off. Turn on \"Allow restarting the computer from the admin page\" in Settings, advanced, to use this."}</CardDescription></CardHeader>
        <CardContent><ConfirmButton destructive variant="destructive" disabled={!canReboot} label="Restart the computer" title="Restart the whole computer?" confirm="Restart now" text="Everything on this computer closes and starts again, including anything else running on it. The Stack comes back by itself when the computer is up." onConfirm={reboot} /></CardContent>
      </Card>
    </div>
  );
}
