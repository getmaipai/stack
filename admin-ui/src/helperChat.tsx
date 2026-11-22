// The Helper's chat state, kept above every screen so the slide-over and the Helper screen show one chat, and
// closing and reopening the panel loses nothing. The history lives in the Stack's database; this holds the copy
// the page is showing and the proposal cards that wait for a Confirm.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import type { HelperMessage, HelperProposal, HelperStatus } from "./api";
import { plainError, useLoad } from "./shared";
import type { Notify } from "./screens";
import { expandCommand } from "./helperText";

export interface HelperChatState {
  status: ReturnType<typeof useLoad<HelperStatus>>;
  messages: HelperMessage[];
  pending: HelperProposal[];
  busy: boolean;
  /** The card being confirmed or cancelled right now. */
  deciding: string | null;
  installing: boolean;
  error: string | null;
  send: (raw: string) => Promise<void>;
  confirm: (p: HelperProposal) => Promise<void>;
  cancel: (p: HelperProposal) => Promise<void>;
  clear: () => Promise<void>;
  install: (model: HelperStatus["model"]) => Promise<void>;
}

const Ctx = createContext<HelperChatState | null>(null);
export function useHelperChat(): HelperChatState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useHelperChat needs a HelperProvider.");
  return v;
}

const stamp = () => new Date().toISOString();

export function HelperProvider({ notify, refresh, children }: { notify: Notify; refresh: () => void; children: ReactNode }) {
  const status = useLoad<HelperStatus>(() => api.helperStatus());
  const history = useLoad(() => api.helperHistory());
  const [messages, setMessages] = useState<HelperMessage[]>([]);
  const [pending, setPending] = useState<HelperProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  useEffect(() => { if (history.data) { setMessages(history.data.messages); setPending(history.data.pending); } }, [history.data]);
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

  const send = useCallback(async (raw: string) => {
    const command = expandCommand(raw);
    if (command && "clear" in command) { await clear(); return; }
    const message = (command && "send" in command ? command.send : raw).trim();
    if (!message || busyRef.current) return;
    busyRef.current = true; setError(null); setBusy(true);
    setMessages((m) => [...m, { role: "user", content: message, at: stamp() }]);
    try {
      const r = await api.helperChat(message);
      setMessages((m) => [...m, { role: "assistant", content: r.reply, at: stamp(), tools: r.tools }]);
      setPending((p) => [...p, ...r.pending]);
      status.reload();
    } catch (e) { setError(plainError(e, "The Helper did not answer. Try again in a moment.")); }
    finally { busyRef.current = false; setBusy(false); }
  }, [clear, status]);

  const confirm = useCallback(async (p: HelperProposal) => {
    setDeciding(p.id);
    try {
      const r = await api.helperConfirm(p);
      setMessages((m) => [...m, { role: "assistant", content: `Done: ${r.summary}.`, at: stamp() }]);
      refresh();
    } catch (e) { setMessages((m) => [...m, { role: "assistant", content: plainError(e, "That did not work. Nothing was changed."), at: stamp() }]); }
    setPending((list) => list.filter((x) => x.id !== p.id));
    setDeciding(null);
  }, [refresh]);

  const cancel = useCallback(async (p: HelperProposal) => {
    setDeciding(p.id);
    try { await api.helperCancel(p.id); setMessages((m) => [...m, { role: "assistant", content: `Okay, I did not do it: ${p.summary}.`, at: stamp() }]); }
    catch (e) { setMessages((m) => [...m, { role: "assistant", content: plainError(e, "That request was already gone. Nothing was changed."), at: stamp() }]); }
    setPending((list) => list.filter((x) => x.id !== p.id));
    setDeciding(null);
  }, []);

  const install = useCallback(async (model: HelperStatus["model"]) => {
    try { await api.installHelperModel(model); setInstalling(true); notify("Downloading the Helper. The chat opens here when it is ready."); }
    catch (e) { notify(plainError(e, "The Helper could not be installed. Try again.")); }
  }, [notify]);

  const value = useMemo<HelperChatState>(() => ({ status, messages, pending, busy, deciding, installing, error, send, confirm, cancel, clear, install }), [status, messages, pending, busy, deciding, installing, error, send, confirm, cancel, clear, install]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
