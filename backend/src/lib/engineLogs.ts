// A live, redacted buffer of each engine's recent output (STACK-ENGINE-LOG-01).
// Reuse: the redaction rules are adminActions' `redactLogLine`; the exit
// evidence the supervisor already keeps (crashClassifier `stderrEvidence`)
// stays as it is, this adds the running view. One ring per role, lines
// redacted BEFORE they are stored, so nothing sensitive is ever held, and
// subscribers get the same redacted lines. Prompt text is never stored:
// lines that carry a prompt, a message body or a token dump are replaced.
import { redactLogLine } from "@/lib/adminActions";

export const ENGINE_LOG_LINES = 500;
const LINE_MAX = 300;
const HIDDEN = "[prompt text hidden]";
// Engines at a verbose level echo what they were asked. Each rule hides the value, keeps the line's shape.
const PROMPT_RULES: Array<[RegExp, string]> = [
  // JSON bodies and message arrays: "content":"...", "prompt":"...", "text":"..." (strings, escaped quotes included).
  [/(["']?(?:content|prompt|input|text|messages?|system|query|instruction)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi, `$1"${HIDDEN}"`],
  // Unquoted: `prompt = text`, `prompt: text` to the end of the line.
  [/\b((?:prompt|user_prompt|system_prompt|formatted_prompt|input_text|chat_template_input)\s*[:=]\s*)\S.*$/gi, `$1${HIDDEN}`],
  // --verbose-prompt token echo: `   42 -> 'piece'`.
  [/^\s*\d+\s*->\s*'.*'\s*$/, HIDDEN],
];

/** One engine output line, with secrets (adminActions' rules) and prompt text replaced, cut to a sane length. */
export function redactEngineLine(line: string): string {
  let out = redactLogLine(line.replace(/\r$/, ""));
  for (const [pattern, replacement] of PROMPT_RULES) out = out.replace(pattern, replacement);
  return out.length > LINE_MAX ? `${out.slice(0, LINE_MAX)}…` : out;
}

export interface EngineLogLine { seq: number; at: string; role: string; line: string }
const rings = new Map<string, EngineLogLine[]>();
const listeners = new Set<(entry: EngineLogLine) => void>();
let seq = 0;

export function pushEngineLine(role: string, raw: string): void {
  if (raw.trim() === "") return;
  const entry: EngineLogLine = { seq: ++seq, at: new Date().toISOString(), role, line: redactEngineLine(raw) };
  const ring = rings.get(role) ?? [];
  ring.push(entry);
  if (ring.length > ENGINE_LOG_LINES) ring.splice(0, ring.length - ENGINE_LOG_LINES);
  rings.set(role, ring);
  for (const listener of listeners) { try { listener(entry); } catch { /* A broken subscriber never stops the engine's output. */ } }
}

/** The newest lines of one role, oldest first. */
export function engineLogLines(role: string, tail = 200): EngineLogLine[] { return (rings.get(role) ?? []).slice(-tail); }
export function engineLogRoles(): string[] { return [...rings.keys()].sort(); }
export function subscribeEngineLogs(listener: (entry: EngineLogLine) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function __resetEngineLogsForTests(): void { rings.clear(); listeners.clear(); seq = 0; }

/** Reads an engine's output stream line by line into its ring, and resolves with the whole text for the exit evidence the supervisor already builds. The supervisor's one hook. */
export async function captureEngineOutput(role: string, stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let whole = "", pending = "";
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      whole += text; pending += text;
      const lines = pending.split("\n"); pending = lines.pop() ?? "";
      for (const line of lines) pushEngineLine(role, line);
    }
  } catch { /* A stream cut by a killed process ends the capture. */ }
  if (pending) pushEngineLine(role, pending);
  return whole;
}
