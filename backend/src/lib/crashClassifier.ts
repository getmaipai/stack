// ROBUST-01: what a dead engine's exit says about why it died, in words a
// person can act on. The inputs are only what the Stack saw: the exit
// code, the signal, the last stderr lines, and the machine's memory level
// at that moment. An unknown cause says it is unknown; it never guesses.
export type CrashKind = "out_of_memory" | "killed" | "missing_file" | "port_in_use" | "bad_config" | "unknown";

export interface CrashEvidence {
  exitCode: number | null;
  signal: string | null;
  stderrTail: string[];
  /** The whole-computer memory level when the engine exited (normal, warn, critical). */
  memoryLevel?: "normal" | "warn" | "critical";
}

export interface CrashVerdict {
  kind: CrashKind;
  /** One sentence: what happened, in terms the person sees. */
  cause: string;
  /** One sentence: what to do about it. */
  fix: string;
  /** Another try cannot help until something outside the engine changes. */
  retryHelps: boolean;
}

const OOM = /out of memory|cannot allocate memory|std::bad_alloc|MTLCommandBuffer.*(insufficient|out of)|kIOGPUCommandBufferCallbackErrorOutOfMemory|failed to allocate|ggml_backend_.*alloc/i;
const MISSING = /no such file or directory|file not found|failed to open|cannot open|unable to load model|failed to load model|ENOENT|does not exist/i;
const PORT = /address already in use|EADDRINUSE|failed to bind|bind failed|port .* in use/i;
const CONFIG = /invalid (argument|option|value)|unknown (argument|option|flag)|unrecognized (argument|option)|error: argument|usage:|bad config|unsupported (architecture|model)/i;

export function classifyCrash(evidence: CrashEvidence): CrashVerdict {
  const text = evidence.stderrTail.join("\n");
  const signal = evidence.signal?.toUpperCase() ?? null;
  const killedBySignal = signal === "SIGKILL" || evidence.exitCode === 137;
  if (OOM.test(text) || (killedBySignal && evidence.memoryLevel && evidence.memoryLevel !== "normal")) {
    return { kind: "out_of_memory", cause: "The computer ran out of memory and the engine was stopped.", fix: "Close big apps or free memory; the engine restarts itself once memory recovers.", retryHelps: true };
  }
  if (killedBySignal) {
    return { kind: "killed", cause: "The system stopped the engine without a message (a SIGKILL, usually the memory manager).", fix: "The engine restarts itself. If it keeps happening, free memory or choose a smaller chat model.", retryHelps: true };
  }
  if (PORT.test(text)) return { kind: "port_in_use", cause: "The engine could not open its port because another program holds it.", fix: "The engine picks a new port on its next start; if it keeps failing, restart the Stack.", retryHelps: true };
  if (MISSING.test(text)) return { kind: "missing_file", cause: "A file the engine needs is missing or unreadable.", fix: "Reinstall the model or the engine from Models, then restart the engine.", retryHelps: false };
  if (CONFIG.test(text)) return { kind: "bad_config", cause: "The engine refused its launch settings.", fix: "Reset the engine settings to their defaults, then restart the engine.", retryHelps: false };
  return { kind: "unknown", cause: `The engine stopped on its own${evidence.exitCode !== null ? ` (exit code ${evidence.exitCode})` : signal ? ` (${signal})` : ""} and left no clear reason.`, fix: "The engine restarts itself; the last log lines are in the details.", retryHelps: true };
}

const METAL_COMPILER = /MTLCompilerService|ggml_metal_library/i;
const ERROR_LINE = /(^|\s)E\s|error|failed|unable to/i;
const FIRST_ERRORS = 5;
const TAIL_LINES = 5;
const LINE_MAX = 240;
const REASON_MAX = 1_200;

const clip = (line: string): string => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line);

/** The first error lines of an engine's stderr, then its last lines, each once and in log order. */
export function stderrEvidence(stderr: string, tailLines = TAIL_LINES, firstErrors = FIRST_ERRORS): string[] {
  const lines = stderr.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const tailStart = Math.max(0, lines.length - tailLines);
  const first = lines.slice(0, tailStart).filter((l) => ERROR_LINE.test(l)).slice(0, firstErrors);
  return [...first, ...lines.slice(tailStart)].map(clip);
}

/** Why an engine that exited before becoming healthy did so: a known cause in one sentence, else the exit code with the first errors and the tail. */
export function describeStartFailure(exitCode: number | string | null, stderr: string): string {
  if (METAL_COMPILER.test(stderr)) return "The Mac's graphics compiler is not responding. Restart the Mac, then chat starts again on its own.";
  if (OOM.test(stderr)) return "The computer ran out of memory while the engine was loading. Close big apps or choose a smaller model; the engine starts again once memory recovers.";
  const lines = stderrEvidence(stderr).join(" | ");
  const text = `Engine exited before becoming healthy (code ${exitCode})${lines ? `: ${lines}` : "."}`;
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text;
}
