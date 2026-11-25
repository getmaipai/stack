import { useEffect, useState } from "react";
import { Code2, FlaskConical, MessagesSquare } from "lucide-react";
import { Button } from "@maipai/ui/src/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maipai/ui/src/ui/card";
import { api } from "./api";
import { ago, bytes } from "./format";
import { IconChip, List, ListRow, Pill, SectionHeader } from "./kit";
import { failureText, modeBusy, modeHeadline, modeName, roleTone, roleWord } from "./modeText";
import type { ModeView } from "./modeText";
import { ConfirmButton, Failure, Loading, plainError, useLoad } from "./shared";
import type { Notify } from "./screens";

/** The Stack decides which features are on. Normal keeps every feature available; Max coding gives the machine to one large coding model. */
export function Modes({ notify }: { notify: Notify }) {
  const mode = useLoad<ModeView>(() => api.codingMode());
  const roles = useLoad(() => api.roles());
  const [sending, setSending] = useState(false);
  const view = mode.data;
  const busy = view ? modeBusy(view) : false;
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => { mode.reload(); roles.reload(); }, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  async function change(target: "normal" | "coding") {
    setSending(true);
    try { await api.setCodingMode(target); notify(`Switching to ${modeName(target)}. This page shows the progress.`); }
    catch (e) { notify(plainError(e, "The switch could not start. Nothing was changed.")); }
    finally { setSending(false); mode.reload(); }
  }
  async function selfTest() {
    try { await api.codingSelfTest(); notify("The self-test is running. The result shows here in a minute."); setTimeout(mode.reload, 4000); }
    catch (e) { notify(plainError(e, "The self-test could not start.")); }
  }
  const failed = view ? failureText(view) : null;
  return (
    <div className="flex flex-col gap-8">
      {mode.error && <Failure title="The mode could not be read" message={mode.error} />}
      {!view && !mode.error && <Loading />}
      {view && (
        <section className="flex flex-col gap-4" aria-labelledby="mode-now">
          <SectionHeader id="mode-now" eyebrow="Mode" title={modeName(view.mode)} description={modeHeadline(view)} action={busy ? <Pill tone="warn">Working</Pill> : <Pill tone="ok">Stable</Pill>} />
          {failed && <Failure title="The switch did not finish" message={failed} />}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-3 text-base"><IconChip Icon={MessagesSquare} size="sm" />Normal</CardTitle><CardDescription>Everyday use. Chat, pictures, videos, songs, voice and search are all available. Coding uses the smaller model.</CardDescription></CardHeader>
              <CardContent>{view.mode === "normal" && !busy ? <Pill tone="ok">Current</Pill> : <Button variant="outline" size="sm" disabled={busy || sending} onClick={() => void change("normal")}>{view.state === "failed" && view.target === "normal" ? "Try again" : "Switch to Normal"}</Button>}</CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-3 text-base"><IconChip Icon={Code2} tone="warn" size="sm" />Max coding</CardTitle><CardDescription>One large coding model gets the whole computer. Chat pauses briefly while it loads. Pictures, videos and songs wait until you switch back to Normal.</CardDescription></CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                {view.mode === "coding" && !busy ? <Pill tone="ok">Current</Pill> : (
                  <ConfirmButton variant="default" label={view.state === "failed" && view.target === "coding" ? "Try again" : "Switch to Max coding"} disabled={busy || sending || !view.available} title="Switch to Max coding?" confirm="Switch" text="Chat pauses for a few minutes while the large model loads. Pictures, videos and songs wait until you switch back to Normal." onConfirm={() => change("coding")} />
                )}
                {!view.available && view.reason && view.state !== "failed" && <p className="text-muted-foreground">{view.reason}</p>}
                <p className="text-muted-foreground">Memory needed {bytes(view.memory.plan_bytes)} of {bytes(view.memory.budget_bytes)} available.</p>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-3 text-base"><IconChip Icon={FlaskConical} tone="muted" size="sm" />Self-test</CardTitle><CardDescription>{view.self_test.passed_at ? `Last passed ${ago(view.self_test.passed_at)}.${view.self_test.stale ? " It is out of date. Run it again." : ""}` : "Never passed on this computer."} It loads the large model and checks a reply, a tool call and thinking, then switches back.</CardDescription></CardHeader>
            <CardContent><ConfirmButton label="Run the self-test" disabled={busy} title="Run the self-test?" confirm="Run" text="Chat pauses for a few minutes while the large model loads, then everything returns to Normal." onConfirm={selfTest} /></CardContent>
          </Card>
        </section>
      )}
      <section className="flex flex-col gap-4" aria-labelledby="features-on">
        <SectionHeader id="features-on" eyebrow="Features" title="What is on" count={roles.data?.roles.length} description="Each feature, whether it is running, and why when it is not." />
        {roles.error && <Failure title="The features could not be read" message={roles.error} />}
        {roles.data && (
          <List label="Features">
            {roles.data.roles.map((r) => (
              <ListRow key={r.id} Icon={Code2} tone={roleTone(r.state.state)} title={r.label} pills={<Pill tone={roleTone(r.state.state)}>{roleWord(r.state.state)}</Pill>} detail={r.plain_reason ?? r.reason ?? r.state.reason ?? (r.model ? r.model.id : undefined)} />
            ))}
          </List>
        )}
      </section>
    </div>
  );
}
