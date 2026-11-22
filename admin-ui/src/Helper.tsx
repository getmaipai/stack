import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Check, Download, Send, Sparkles, Trash2, X } from "lucide-react";
import { Badge } from "@maipai/ui/src/ui/badge";
import { Button } from "@maipai/ui/src/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maipai/ui/src/ui/card";
import { Textarea } from "@maipai/ui/src/ui/textarea";
import { api } from "./api";
import type { HelperMessage, HelperPending, HelperStatus } from "./api";
import { bytes } from "./format";
import { ConfirmButton, Failure, Loading, plainError, useLoad } from "./shared";
import type { Notify } from "./screens";
import { expandCommand, helperStateWord } from "./helperText";

const SUGGESTIONS = ["Is everything healthy?", "How much memory is free?", "Which features are on?", "Is an update available?"];
const MAX = 2000;

/** Screen 11: the Helper, a small chat assistant with its own model. Changes wait for an Approve click. */
export function Helper({ notify }: { notify: Notify }) {
  const status = useLoad<HelperStatus>(() => api.helperStatus());
  const history = useLoad(() => api.helperHistory());
  const [messages, setMessages] = useState<HelperMessage[]>([]);
  const [pending, setPending] = useState<HelperPending[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { if (history.data) { setMessages(history.data.messages); setPending(history.data.pending); } }, [history.data]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [messages, pending, busy]);
  // While the download runs the status is polled so the Install button turns into the chat by itself.
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => status.reload(), 4000);
    return () => clearInterval(timer);
  }, [installing, status]);
  useEffect(() => { if (status.data?.installed) setInstalling(false); }, [status.data?.installed]);

  const clear = useCallback(async () => {
    try { await api.helperClear(); setMessages([]); setPending([]); setError(null); } catch (e) { notify(plainError(e, "The chat could not be cleared. Try again.")); }
  }, [notify]);

  async function send(raw: string) {
    const command = expandCommand(raw);
    if (command && "clear" in command) { setText(""); await clear(); return; }
    const message = (command && "send" in command ? command.send : raw).trim();
    if (!message || busy) return;
    setText(""); setError(null); setBusy(true);
    setMessages((m) => [...m, { role: "user", content: message, at: new Date().toISOString() }]);
    try {
      const r = await api.helperChat(message);
      setMessages((m) => [...m, { role: "assistant", content: r.reply, at: new Date().toISOString(), tools: r.tools }]);
      setPending((p) => [...p, ...r.pending]);
      status.reload();
    } catch (e) { setError(plainError(e, "The Helper did not answer. Try again in a moment.")); }
    finally { setBusy(false); }
  }
  async function decide(p: HelperPending, yes: boolean) {
    try {
      if (yes) { const r = await api.helperApprove(p.id); setMessages((m) => [...m, { role: "assistant", content: `Done: ${r.summary}.`, at: new Date().toISOString() }]); }
      else { await api.helperDeny(p.id); setMessages((m) => [...m, { role: "assistant", content: `Okay, I did not do it: ${p.summary}.`, at: new Date().toISOString() }]); }
    } catch (e) { setMessages((m) => [...m, { role: "assistant", content: plainError(e, "That did not work. Nothing was changed."), at: new Date().toISOString() }]); }
    setPending((list) => list.filter((x) => x.id !== p.id));
  }
  async function install(model: HelperStatus["model"]) {
    try { await api.installHelperModel(model); setInstalling(true); notify("Downloading the Helper. The chat opens here when it is ready."); }
    catch (e) { notify(plainError(e, "The Helper could not be installed. Try again.")); }
  }
  function onSubmit(e: FormEvent) { e.preventDefault(); void send(text); }

  if (status.loading && !status.data) return <Loading />;
  if (status.error && !status.data) return <Failure title="The Helper's status could not be read" message={status.error} />;
  const s = status.data!;
  if (!s.installed) {
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Sparkles aria-hidden="true" />Install the Helper</CardTitle>
          <CardDescription>The Helper answers questions about this computer and, when you approve, changes things. It has its own small model, so it works even when chat is down. It wakes when you write to it and sleeps after {s.keep_warm_minutes} idle minutes. Nothing leaves this computer.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">{s.model.id}, {s.model.licence}, about {bytes(s.model.approx_bytes)}. Downloaded from its pinned source and checked against its checksum.</p>
          <div><Button disabled={installing} onClick={() => { void install(s.model); }}><Download aria-hidden="true" />{installing ? "Downloading" : `Install the Helper (about ${bytes(s.model.approx_bytes)})`}</Button></div>
        </CardContent>
      </Card>
    );
  }
  const waking = busy && s.state !== "ready" && s.state !== "loaded" && s.state !== "busy";
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <div className="flex items-center gap-2 text-sm">
        <Badge variant="outline">{helperStateWord(s.state, waking)}</Badge>
        <span className="text-muted-foreground">Asks first. Nothing changes until you click Approve.</span>
        <ConfirmButton variant="ghost" label={<><Trash2 aria-hidden="true" />Clear</>} title="Clear the chat?" text="The messages are deleted from the Stack's database and anything waiting for approval is dropped." confirm="Clear" onConfirm={clear} />
      </div>
      <div className="flex min-h-[40dvh] max-h-[calc(100dvh-22rem)] flex-col gap-3 overflow-y-auto glass p-4 text-card-foreground" role="log" aria-label="Chat with the Helper" aria-live="polite">
        {messages.length === 0 && !busy && (
          <div className="m-auto flex max-w-md flex-col items-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">Ask about health, memory, features, updates or settings. Type / for shortcuts: /health, /memory, /restart, /new.</p>
            <div className="flex flex-wrap justify-center gap-2">{SUGGESTIONS.map((q) => <Button key={q} variant="outline" size="sm" onClick={() => { void send(q); }}>{q}</Button>)}</div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={`${m.at}-${i}`} className={m.role === "user" ? "ms-auto max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground" : "me-auto max-w-[90%] rounded-2xl bg-muted px-3 py-2 text-sm text-foreground"}>
            <p className="whitespace-pre-wrap break-words">{m.content}</p>
            {m.tools && m.tools.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Looked at: {[...new Set(m.tools)].map((t) => t.replace(/^get_/, "").replace(/_/g, " ")).join(", ")}</p>}
          </div>
        ))}
        {pending.map((p) => (
          <div key={p.id} className="me-auto flex w-full max-w-[90%] flex-col gap-2 rounded-2xl border bg-background px-3 py-2 text-sm" role="group" aria-label="Waiting for your approval">
            <p className="font-medium">{p.summary}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => { void decide(p, true); }}><Check aria-hidden="true" />Approve</Button>
              <Button size="sm" variant="outline" onClick={() => { void decide(p, false); }}><X aria-hidden="true" />Deny</Button>
            </div>
          </div>
        ))}
        {busy && <p className="me-auto rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground" role="status">{waking ? "The Helper is waking up. This takes a few seconds." : "Thinking"}</p>}
        <div ref={end} />
      </div>
      {error && <Failure title="The Helper did not answer" message={error} />}
      <form onSubmit={onSubmit} className="flex items-end gap-2">
        <label className="sr-only" htmlFor="helper-input">Message the Helper</label>
        <Textarea id="helper-input" value={text} maxLength={MAX} rows={1} placeholder="Ask the Stack" className="min-h-10 flex-1"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }} />
        <span className="hidden pb-2 text-xs text-muted-foreground sm:block" aria-label="Characters used">{text.length}/{MAX}</span>
        <Button type="submit" disabled={busy || text.trim() === ""} aria-label="Send"><Send aria-hidden="true" /></Button>
      </form>
    </div>
  );
}
