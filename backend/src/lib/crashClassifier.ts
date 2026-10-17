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
