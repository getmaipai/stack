import { useEffect, useState } from "react";
import { Badge } from "@maipai/ui/src/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@maipai/ui/src/ui/card";
import { StatusIndicator } from "@maipai/ui/src/ui/status";
import { api } from "./api";
import type { Applied, CatalogModel, Mode, Plan, Recommendation, Role } from "./api";
import type { Snapshot } from "./live";
import { bytes } from "./format";
import { MODE_WORDS, catalogForRole, fitWord, installedState, planStateWord } from "./manage";
import { ConfirmButton, Failure, Loading, plainError, useLoad } from "./shared";
import { PriorityList } from "./Features";
import type { Notify } from "./screens";

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
            <span className="text-muted-foreground">{fitWord(r.fit)}{r.peak_bytes ? `, about ${bytes(r.peak_bytes)}` : ""}</span>
            {r.reason && <span className="w-full text-xs text-muted-foreground">{r.reason}</span>}
          </li>
        ))}
      </ul>
      {plan.notes.length > 0 && <ul className="list-disc ps-5 text-sm text-muted-foreground">{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}

function Tier({ roles, refresh, notify }: { roles: Role[]; refresh: () => void; notify: Notify }) {
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
    finally { setBusy(false); refresh(); rec.reload(); }
  }
  const saved = r.saved;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Setup for this computer</CardTitle>
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
          <h3 id="rec-h" className="text-sm font-semibold">{MODE_WORDS.custom_recommended.title}: what would happen</h3>
          <PlanTable plan={r.custom_recommended.plan} labels={labels} />
          {r.custom_recommended.why.length > 0 && <ul className="list-disc ps-5 text-sm text-muted-foreground">{r.custom_recommended.why.map((w) => <li key={w}>{w}</li>)}</ul>}
        </section>
        <div className="flex flex-wrap gap-2">
          {r.matched && <ConfirmButton variant="default" disabled={busy} label={`Use ${MODE_WORDS.matched.title}`} title="Use the matched setup?" confirm="Apply" text={`${MODE_WORDS.matched.text} This sets which features are on and their order, and starts any missing model downloads.`} onConfirm={() => apply("matched")} />}
          <ConfirmButton variant={r.matched ? "outline" : "default"} disabled={busy} label={`Use ${MODE_WORDS.custom_recommended.title}`} title="Use the custom recommended setup?" confirm="Apply" text={`${MODE_WORDS.custom_recommended.text} This changes which features are on and their order, and starts any missing model downloads.`} onConfirm={() => apply("custom_recommended")} />
          <ConfirmButton disabled={busy} label="Keep my own choices" title="Check and keep your own choices?" confirm="Apply" text="Keeps the features and order you set on the Features and Models screens, checked for fit. Nothing is turned on or off for you." onConfirm={() => apply("custom")} />
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

function ModelRow({ model, state, size, onInstall, onRemove, busy, downloading }: { downloading: boolean; model: CatalogModel; state: "missing" | "installed" | "loaded"; size?: number | null; onInstall: () => void; onRemove: () => void; busy: boolean }) {
  const expected = model.download?.approx_bytes;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 break-words">{model.id}<span className="block text-xs text-muted-foreground">{[model.sizing?.profile, model.sizing?.quantization, model.license].filter(Boolean).join(", ")}{expected ? `, ${bytes(expected)}` : ""}</span></span>
      <Badge variant={state === "missing" ? "outline" : "secondary"}>{state === "missing" ? (downloading ? "Downloading" : "Not installed") : state === "loaded" ? "In use" : size ? `Installed, ${bytes(size)}` : "Installed"}</Badge>
      {state === "missing"
        ? <ConfirmButton label="Download" disabled={busy || downloading} title={`Download ${model.id}?`} confirm="Download" text={`${expected ? `About ${bytes(expected)} will be downloaded` : "The file will be downloaded"} from ${model.repo ?? "its pinned source"} and checked against its published fingerprint before it is used.`} onConfirm={onInstall} />
        : <ConfirmButton label="Remove" variant="ghost" destructive disabled={busy || state === "loaded"} title={`Remove ${model.id}?`} confirm="Remove" text="The file is deleted from this computer. You can download it again later." onConfirm={onRemove} />}
    </li>
  );
}

export function Models({ snap, refresh, notify }: { snap: Snapshot; refresh: () => void; notify: Notify }) {
  const catalog = useLoad(() => api.catalog());
  const installed = useLoad(() => api.models());
  const [busy, setBusy] = useState<string | null>(null);
  // Downloads finish after the request answers: keep asking until the model shows as installed (at most 10 minutes).
  const [waiting, setWaiting] = useState<string[]>([]);
  const reloadInstalled = installed.reload;
  const have0 = installed.data?.models;
  useEffect(() => {
    if (waiting.length === 0) return;
    if (have0 && waiting.every((id) => installedState(id, have0) !== "missing")) { setWaiting([]); return; }
    const t = setInterval(reloadInstalled, 3000);
    const stop = setTimeout(() => setWaiting([]), 600000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, [waiting, have0, reloadInstalled]);
  if (!snap.loaded || catalog.loading || installed.loading) return <Loading />;
  if (!snap.roles) return <Failure title="Could not reach the Stack" message={snap.error ?? "No answer yet."} />;
  if (!catalog.data || !installed.data) return <Failure title="The model list could not be read" message={catalog.error ?? installed.error ?? "No answer yet."} />;
  const have = installed.data.models;
  async function run(id: string, what: "install" | "remove", model: CatalogModel) {
    setBusy(id);
    try {
      if (what === "install") { await api.installModel(model); setWaiting((w) => [...w, id]); notify(`Downloading ${id}. This can take a while; the badge changes when it is ready.`); }
      else { await api.removeModel(id); notify(`${id} was removed.`); }
    } catch (e) { notify(plainError(e, `${id} could not be ${what === "install" ? "downloaded" : "removed"}. Try again.`)); }
    finally { setBusy(null); installed.reload(); refresh(); }
  }
  const withModels = snap.roles.map((role) => ({ role, models: catalogForRole(catalog.data!.models, role.id) })).filter((x) => x.models.length > 0);
  return (
    <div className="flex flex-col gap-6">
      <Tier roles={snap.roles} refresh={refresh} notify={notify} />
      <PriorityList roles={snap.roles} refresh={refresh} notify={notify} />
      <section aria-labelledby="models-h" className="flex flex-col gap-3">
        <h3 id="models-h" className="text-lg font-semibold">Models by feature</h3>
        <p className="text-sm text-muted-foreground">Every model here is pinned to one exact file and checked after download. The Stack picks the one that fits your setup; install others to have them ready.</p>
        {withModels.map(({ role, models }) => (
          <Card key={role.id}>
            <CardHeader><CardTitle className="text-base">{role.label}</CardTitle><CardDescription>{role.model ? `Answering with ${role.model.id}.` : "No model chosen yet."}</CardDescription></CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2" aria-label={`${role.label} models`}>
                {models.map((m) => (
                  <ModelRow key={m.id} model={m} busy={busy === m.id} state={installedState(m.id, have)} downloading={waiting.includes(m.id) && installedState(m.id, have) === "missing"} size={have.find((x) => x.id === m.id)?.sizeBytes}
                    onInstall={() => run(m.id, "install", m)} onRemove={() => run(m.id, "remove", m)} />
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
