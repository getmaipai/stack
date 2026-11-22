import { useState } from "react";
import { IconChip } from "./kit";
import { CircleArrowUp, CircleCheck } from "lucide-react";
import { Badge } from "@maipai/ui/src/ui/badge";
import { Button } from "@maipai/ui/src/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@maipai/ui/src/ui/card";
import { api } from "./api";
import type { Updates as UpdatesDoc } from "./api";
import { ago } from "./format";
import { ConfirmButton, Failure, Loading, plainError, useLoad } from "./shared";
import type { Notify } from "./screens";

// The Stack has no read that lists retained previous builds, so the page remembers the
// `previous` tag an update answered with (docs/BACKLOG.md, ADMIN-08 gaps). Per browser only.
const KEY = "stack-admin-previous-builds";
function readPrevious(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>; } catch { return {}; }
}
function writePrevious(v: Record<string, string>): void {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private window: the button just stays hidden */ }
}

/** Screen 7: installed, available, last checked, check, apply, go back. */
export function Updates({ refresh, notify }: { refresh: () => void; notify: Notify }) {
  const doc = useLoad<UpdatesDoc>(() => api.updates());
  const [busy, setBusy] = useState<string | null>(null);
  const [previous, setPrevious] = useState<Record<string, string>>(readPrevious);
  if (doc.loading) return <Loading />;
  if (!doc.data) return <Failure title="Updates could not be read" message={doc.error ?? "No answer yet."} />;
  const u = doc.data;
  async function check() {
    setBusy("check");
    try { doc.set(await api.checkUpdates()); notify("Checked for updates."); }
    catch (e) { notify(plainError(e, "The check could not run. Try again.")); }
    finally { setBusy(null); }
  }
  async function apply(name: string) {
    setBusy(name);
    try {
      const r = await api.applyEngine(name);
      if (r.applied && r.previous) { const next = { ...previous, [name]: r.previous }; setPrevious(next); writePrevious(next); }
      notify(r.applied ? `${name} updated to ${r.tag ?? "the new build"}. The old build is kept so you can go back.` : `${name} was not changed.`);
    } catch (e) { notify(plainError(e, `${name} could not be updated. Nothing was changed.`)); }
    finally { setBusy(null); doc.reload(); refresh(); }
  }
  async function back(name: string, tag: string) {
    setBusy(name);
    try {
      await api.rollbackEngine(name, tag);
      const { [name]: _used, ...rest } = previous; setPrevious(rest); writePrevious(rest);
      notify(`${name} went back to ${tag}.`);
    } catch (e) { notify(plainError(e, `${name} could not go back. Nothing was changed.`)); }
    finally { setBusy(null); doc.reload(); refresh(); }
  }
  const lastChecked = u.engines.map((e) => e.lastChecked).filter(Boolean).sort().at(-1);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="me-auto text-sm text-muted-foreground">
          {u.checksEnabled ? (lastChecked ? `Last checked ${ago(lastChecked)}.` : "Not checked yet.") : "Checking for updates is off. Turn it on in Settings, or check by hand."}
        </p>
        <Button disabled={busy !== null} onClick={() => { void check(); }}>{busy === "check" ? "Checking" : "Check now"}</Button>
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Engines">
        {u.engines.map((e) => {
          const newer = e.availableKnown && !!e.available && e.available !== e.installed;
          return (
            <li key={e.name}>
              <Card className="h-full">
                <CardHeader>
                  <CardTitle className="flex items-center gap-3 text-base"><IconChip Icon={newer ? CircleArrowUp : CircleCheck} tone={newer ? "warn" : "ok"} />{e.name}</CardTitle>
                  <CardDescription>{e.installed ? `Installed ${e.installed}` : "Not installed"}{e.availableKnown ? `, newest ${e.available}` : ", newest not known yet"}</CardDescription>
                  <CardAction><Badge variant={newer ? "default" : "secondary"}>{newer ? "Update available" : "Up to date"}</Badge></CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
                  {e.notes && <p>{e.notes}</p>}
                  <div className="flex flex-wrap gap-2">
                    {newer && <ConfirmButton variant="default" disabled={busy !== null} label={busy === e.name ? "Working" : "Update"} title={`Update ${e.name}?`} confirm="Update" text={`${e.name} will stop, switch to ${e.available} and start again. If the new build does not answer, the Stack keeps the old one.`} onConfirm={() => apply(e.name)} />}
                    {previous[e.name] && <ConfirmButton variant="ghost" disabled={busy !== null} label={`Go back to ${previous[e.name]}`} title={`Go back to ${previous[e.name]}?`} confirm="Go back" text={`${e.name} will switch back to ${previous[e.name]}. The chat feature drains and restarts, which can take a moment.`} onConfirm={() => back(e.name, previous[e.name]!)} />}
                  </div>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
      {u.models.entries.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Models</CardTitle><CardDescription>{u.models.lastChecked ? `Checked ${ago(u.models.lastChecked)}.` : "Not checked yet."}</CardDescription></CardHeader>
          <CardContent><ul className="flex flex-col gap-1 text-sm">{u.models.entries.map((m) => <li key={m.id} className="flex flex-wrap gap-2"><span className="me-auto break-all">{m.id}</span><span className="text-muted-foreground">{m.installed}{m.available && m.available !== m.installed ? ` to ${m.available}` : ""}</span></li>)}</ul></CardContent>
        </Card>
      )}
    </div>
  );
}
