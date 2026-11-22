import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowRight, Check, Download, Send, Sparkles, Trash2, X } from "lucide-react";
import { Badge } from "@maipai/ui/src/ui/badge";
import { IconChip, Pill } from "./kit";
import { Button } from "@maipai/ui/src/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maipai/ui/src/ui/card";
import { Textarea } from "@maipai/ui/src/ui/textarea";
import type { HelperProposal } from "./api";
import { bytes } from "./format";
import { ConfirmButton, Failure, Loading } from "./shared";
import { changeLine, helperStateWord, valueWord, waitsText } from "./helperText";
import { useHelperChat } from "./helperChat";

const SUGGESTIONS = ["Is everything healthy?", "What are my coding models?", "Which features are on?", "Turn video off"];
const MAX = 2000;
export const HELPER_INPUT_ID = "helper-input";

/** The card a proposed change waits on: one plain sentence, each value from and to, and Confirm or Cancel. Nothing has changed until Confirm. */
export function ProposalCard({ p, busy, onConfirm, onCancel }: { p: HelperProposal; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const gone = Date.parse(p.expires_at) <= now;
  return (
    <div className="me-auto flex w-full max-w-[95%] flex-col gap-2 rounded-2xl border bg-background p-3 text-sm shadow-xs" role="group" aria-label="Confirm this change" data-testid="proposal-card">
      <p className="font-medium">{p.summary}</p>
      {p.changes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {p.changes.map((c) => (
            <li key={c.label} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-muted px-2 py-1" aria-label={changeLine(c)}>
              <span className="me-auto text-muted-foreground">{c.label}</span>
              <Badge variant="outline">{valueWord(c.from)}</Badge>
              <ArrowRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <Badge>{valueWord(c.to)}</Badge>
            </li>
          ))}
        </ul>
      )}
      {p.note && <p className="text-xs text-muted-foreground">{p.note}</p>}
      <p className="text-xs text-muted-foreground">Nothing has changed yet. {waitsText(p.expires_at, now)}</p>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || gone} onClick={onConfirm}><Check aria-hidden="true" />Confirm</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}><X aria-hidden="true" />Cancel</Button>
      </div>
    </div>
  );
}

/** The chat itself, shared by the Helper screen and the slide-over: messages, waiting cards, and the box to type in. */
export function HelperChat({ compact = false, inputId = HELPER_INPUT_ID }: { compact?: boolean; inputId?: string }) {
  const h = useHelperChat();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const { messages, pending, busy, error, status } = h;
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [messages, pending, busy]);
  function onSubmit(e: FormEvent) { e.preventDefault(); const t = text; setText(""); void h.send(t); }
  const s = status.data!;
  const waking = busy && s.state !== "ready" && s.state !== "loaded" && s.state !== "busy";
  return (
    <div className={compact ? "flex h-full min-h-0 flex-col gap-3" : "mx-auto flex max-w-3xl flex-col gap-3"}>
      <div className="flex items-center gap-2 text-sm">
        <Pill tone={s.state === "ready" || s.state === "loaded" || s.state === "busy" ? "ok" : "muted"}>{helperStateWord(s.state, waking)}</Pill>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">Asks first. Nothing changes until you confirm.</span>
        <ConfirmButton variant="ghost" label={<><Trash2 aria-hidden="true" />Clear</>} title="Clear the chat?" text="The messages are deleted from the Stack's database and anything waiting for a confirm is dropped." confirm="Clear" onConfirm={h.clear} />
      </div>
      <div className={`flex flex-col gap-3 overflow-y-auto glass p-4 text-card-foreground ${compact ? "min-h-0 flex-1" : "min-h-[40dvh] max-h-[calc(100dvh-22rem)]"}`} role="log" aria-label="Chat with the Helper" aria-live="polite">
        {messages.length === 0 && !busy && (
          <div className="m-auto flex max-w-md flex-col items-center gap-3 text-center">
            <IconChip Icon={Sparkles} size="lg" />
            <p className="font-semibold">What would you like to know?</p>
            <p className="text-sm text-muted-foreground">Ask about health, memory, models, tiers or features, or tell me what to change. Type / for shortcuts: /health, /memory, /restart, /new.</p>
            <div className="flex flex-wrap justify-center gap-2">{SUGGESTIONS.map((q) => <Button key={q} variant="outline" size="sm" onClick={() => { void h.send(q); }}>{q}</Button>)}</div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={`${m.at}-${i}`} className={m.role === "user" ? "ms-auto max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground" : "me-auto max-w-[90%] rounded-2xl bg-muted px-3 py-2 text-sm text-foreground"}>
            <p className="whitespace-pre-wrap break-words">{m.content}</p>
            {m.tools && m.tools.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Looked at: {[...new Set(m.tools)].map((t) => t.replace(/^get_/, "").replace(/_/g, " ")).join(", ")}</p>}
          </div>
        ))}
        {pending.map((p) => <ProposalCard key={p.id} p={p} busy={h.deciding === p.id} onConfirm={() => { void h.confirm(p); }} onCancel={() => { void h.cancel(p); }} />)}
        {busy && <p className="me-auto rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground" role="status">{waking ? "The Helper is waking up. This takes a few seconds." : "Thinking"}</p>}
        <div ref={end} />
      </div>
      {error && <Failure title="The Helper did not answer" message={error} />}
      <form onSubmit={onSubmit} className="flex items-end gap-2">
        <label className="sr-only" htmlFor={inputId}>Message the Helper</label>
        <Textarea id={inputId} value={text} maxLength={MAX} rows={1} placeholder="Ask the Stack" className="min-h-10 flex-1"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const t = text; setText(""); void h.send(t); } }} />
        <span className="hidden pb-2 text-xs text-muted-foreground sm:block" aria-label="Characters used">{text.length}/{MAX}</span>
        <Button type="submit" disabled={busy || text.trim() === ""} aria-label="Send"><Send aria-hidden="true" /></Button>
      </form>
    </div>
  );
}

/** Shown in place of the chat until the Helper's model is on disk. */
export function HelperInstall() {
  const h = useHelperChat();
  const s = h.status.data!;
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Sparkles aria-hidden="true" />Install the Helper</CardTitle>
        <CardDescription>The Helper answers questions about this computer and, when you confirm, changes things. It has its own small model, so it works even when chat is down. It wakes when you write to it and sleeps after {s.keep_warm_minutes} idle minutes. Nothing leaves this computer.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">{s.model.id}, {s.model.licence}, about {bytes(s.model.approx_bytes)}. Downloaded from its pinned source and checked against its checksum.</p>
        <div><Button disabled={h.installing} onClick={() => { void h.install(s.model); }}><Download aria-hidden="true" />{h.installing ? "Downloading" : `Install the Helper (about ${bytes(s.model.approx_bytes)})`}</Button></div>
      </CardContent>
    </Card>
  );
}

/** What either place shows: loading, the install card, or the chat. */
export function HelperBody({ compact = false, inputId }: { compact?: boolean; inputId?: string }) {
  const h = useHelperChat();
  const fallbackId = useId();
  if (h.status.loading && !h.status.data) return <Loading />;
  if (h.status.error && !h.status.data) return <Failure title="The Helper's status could not be read" message={h.status.error} />;
  return h.status.data!.installed ? <HelperChat compact={compact} inputId={inputId ?? (compact ? `${fallbackId}-panel` : HELPER_INPUT_ID)} /> : <HelperInstall />;
}

/** Screen 11: the Helper, a small chat assistant with its own model. A change is a card that waits for your Confirm. */
export function Helper() {
  return <HelperBody />;
}
