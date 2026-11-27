import { useState } from "react";
import { Badge } from "@maipai/ui/src/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader } from "@maipai/ui/src/ui/card";
import { StatusIndicator } from "@maipai/ui/src/ui/status";
import { api } from "./api";
import type { Applied, Mode, Plan, PlanRole, Recommendation, Role } from "./api";
import { bytes } from "./format";
import { MODE_WORDS, fitWord, planStateWord } from "./manage";
import { fitCell } from "./fitCell";
import { ConfirmButton, Failure, Loading, plainError, useLoad } from "./shared";
import type { Notify } from "./screens";

// The admin-only part of the AI and models screen (an `extraSection` of the shared page): what this computer's memory can hold,
// in the Stack's own plain words from `POST /profiles/recommend`, and the two ways to apply a ready-made setup. The model picks,
// the recommended setup, priority and downloads are the shared page's; nothing here chooses a model.
/** What the row needs and how much room it leaves, in words, with a bar of the AI memory: what is loaded, what this row adds, and a line at the limit that the bar runs past when the row does not fit. Numbers are the plan's own measured peaks. */
function FitCell({ role, budget }: { role: PlanRole; budget: Plan["budget"] }) {
  const cell = fitCell(role, budget);
  if (!cell) return null;
  const scale = Math.max(cell.endPct, 100);
  const w = (pct: number) => `${(pct / scale) * 100}%`;
  return (
    <span className="flex w-full flex-col gap-1">
      <span className={cell.over ? "text-sm font-medium text-destructive" : "text-sm text-foreground"}>{cell.headline}<span className="ms-2 text-xs font-normal text-muted-foreground">({cell.basis})</span></span>
      <span role="img" aria-label={`${cell.headline}. The line marks the memory limit.`} className="relative block h-2 w-full overflow-hidden rounded-full bg-muted">
        <span className="absolute inset-y-0 start-0 bg-muted-foreground/40" style={{ width: w(Math.min(cell.usedPct, cell.endPct)) }} />
        <span className={`absolute inset-y-0 ${cell.over ? "bg-destructive" : "bg-primary"}`} style={{ insetInlineStart: w(Math.min(cell.usedPct, cell.endPct)), width: w(Math.max(0, cell.endPct - cell.usedPct)) }} />
        <span className="absolute inset-y-0 w-px bg-foreground" style={{ insetInlineStart: w(cell.limitPct) }} />
      </span>
    </span>
  );
}

function PlanTable({ plan, labels }: { plan: Plan; labels: Record<string, string> }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Memory for AI: {bytes(plan.budget.resident_cap_bytes)}. Kept loaded: {bytes(plan.budget.resident_bytes)}. Room left: {bytes(plan.budget.room_bytes)}.
        {plan.budget.tight ? " This is tight, so some features wait their turn." : ""}
      </p>
      <ul className="flex flex-col gap-1" aria-label="What each feature will do">
        {plan.roles.filter((r) => r.state !== "off").map((r) => (
          <li key={r.role} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm">
            <span className="min-w-28 font-medium">{labels[r.role] ?? r.role}</span>
            <Badge variant={r.fit === "refused" ? "destructive" : "secondary"}>{planStateWord(r.state)}</Badge>
            <span className="text-muted-foreground">{fitWord(r.fit)}</span>
            <FitCell role={r} budget={plan.budget} />
            {r.reason && (r.fit !== "fits" || !fitCell(r, plan.budget)) && <span className="w-full text-xs text-muted-foreground">{r.reason}</span>}
          </li>
        ))}
      </ul>
      {plan.notes.length > 0 && <ul className="list-disc ps-5 text-sm text-muted-foreground">{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}

export function ProfilePlanner({ roles, refresh, notify, changed }: { roles: Role[]; refresh: () => void; notify: Notify; changed: () => void }) {
  const rec = useLoad<Recommendation>(() => api.recommend());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Applied | null>(null);
  const labels = Object.fromEntries(roles.map((r) => [r.id, r.label]));
  if (rec.loading) return <Loading />;
  if (!rec.data) return <Failure title="The fit could not be worked out" message={rec.error ?? "No answer yet."} />;
  const r = rec.data;
  async function apply(mode: Mode) {
    setBusy(true);
    try {
      const body = mode === "custom"
        ? { mode, plan: { roles: roles.map((x) => ({ role: x.id, enabled: x.enabled !== false, priority: x.priority ?? 100 })) } }
        : { mode, ...(mode === "matched" && r.matched ? { tier: r.matched.tier } : {}) };
      const out = await api.applyProfile(body);
      setResult(out);
      notify(`${MODE_WORDS[mode].title} applied.${out.installs.length ? ` ${out.installs.length} download${out.installs.length === 1 ? "" : "s"} started.` : ""}`);
    } catch (e) { notify(plainError(e, "The setup could not be applied. Nothing was changed.")); }
    finally { setBusy(false); refresh(); changed(); rec.reload(); }
  }
  const saved = r.saved;
  return (
    <Card>
      <CardHeader>
        <CardDescription>This computer has about {Math.round(r.memory.gb)} GB of memory for AI. {r.matched ? r.matched.reason : "No ready-made setup matches this amount of memory closely, so the recommended custom setup below is the best fit."}</CardDescription>
        {saved && <CardAction><Badge variant="secondary">Now: {MODE_WORDS[saved.mode].title}</Badge></CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {r.replan?.needed && <Failure title="Worth another look" message={r.replan.reason ?? "The memory or the chosen features changed since this setup was applied."} />}
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Sizes">
          {r.templates.map((t) => (
            <li key={t.tier} className="rounded-lg border p-3 text-sm">
              <p className="flex items-center gap-2 font-medium"><StatusIndicator status={t.match ? "online" : t.cleared ? "maintenance" : "offline"} ping={false} />{t.min_gb} GB and up<span className="ms-auto text-xs font-normal text-muted-foreground">{t.match ? "Best match" : t.cleared ? "Fits" : "Too big"}</span></p>
              <p className="mt-1 text-xs text-muted-foreground">{t.label}</p>
              <p className="mt-2 text-xs text-muted-foreground">Stays loaded: {t.resident.length ? t.resident.map((x) => labels[x] ?? x).join(", ") : "nothing"}</p>
              {t.not_available.length > 0 && <p className="text-xs text-muted-foreground">Not at this size: {t.not_available.map((x) => labels[x] ?? x).join(", ")}</p>}
            </li>
          ))}
        </ul>
        <section aria-labelledby="rec-h" className="flex flex-col gap-2">
          <h3 id="rec-h" className="text-sm font-semibold">What the recommended setup would do</h3>
          <PlanTable plan={r.custom_recommended.plan} labels={labels} />
          {r.custom_recommended.why.length > 0 && <ul className="list-disc ps-5 text-sm text-muted-foreground">{r.custom_recommended.why.map((w) => <li key={w}>{w}</li>)}</ul>}
        </section>
        <div className="flex flex-wrap gap-2">
          {r.matched && <ConfirmButton variant="default" disabled={busy} label={`Use ${MODE_WORDS.matched.title}`} title="Use the matched setup?" confirm="Apply" text={`${MODE_WORDS.matched.text} This sets which features are on and their order, and starts any missing model downloads.`} onConfirm={() => apply("matched")} />}
          <ConfirmButton variant={r.matched ? "outline" : "default"} disabled={busy} label="Keep my own choices" title="Check and keep your own choices?" confirm="Apply" text="Keeps the features, order and models you chose above, checked for fit. Nothing is turned on or off for you." onConfirm={() => apply("custom")} />
        </div>
        {result && (
          <div className="rounded-lg border p-3 text-sm" role="status">
            <p className="font-medium">Applied {MODE_WORDS[result.mode].title} ({result.tier}).</p>
            {result.installs.length > 0 && <p className="text-muted-foreground">Downloading: {result.installs.map((i) => i.model).join(", ")}.</p>}
            {result.skipped.map((s) => <p key={s.model} className="text-muted-foreground">{s.model}: {s.reason}</p>)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

