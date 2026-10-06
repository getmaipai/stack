// What a picture-reading model costs on this machine, read from a real
// load and a real picture (VISION-01b for the vision role; VISION-02b for
// a chat model that reads pictures itself). Usage (a scratch Stack with
// the pins installed; the live Stack is read only, never changed):
//   bun run scripts/bench/vision-measure.ts <picture> "<question>" \
//     [--role vision|chat] [--model <id>] [--pid <engine pid>] [scratch url] [live stack url]
// The scratch url may also be a bare llama-server started by hand (a run
// outside the governor): pass its --pid, and the Stack-only readings are
// left empty.
// It prints one JSON object: whole-machine available memory before, at
// its lowest while the role loads and reads the picture, and after; the
// kernel's pressure level at its highest; the role's process memory and
// the context it launched at; first-text latency cold (load included)
// and warm, and a text-only request on the same process, with the
// engine's own timings; the live chat's context and pid before and after.
// Available memory is free plus inactive plus speculative pages, the
// governor's own reading.
//
// A watchdog stops the run if the kernel stays at warn pressure (level 2)
// for three seconds, or reaches critical (level 4) at all: it unloads the
// role on the scratch Stack and prints what it measured so far.
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  argv.splice(index, 2);
  return value;
};
const role = (flag("role") ?? "vision") as "vision" | "chat";
const modelId = flag("model");
const pidArg = flag("pid");
const enginePid = pidArg ? Number(pidArg) : null;
const [picture, question, scratchArg, liveArg] = argv;
if (!picture || !question) { console.error("usage: vision-measure.ts <picture> <question> [--role vision|chat] [--model id] [scratch url] [live url]"); process.exit(1); }
const scratch = (scratchArg ?? "http://127.0.0.1:8791").replace(/\/$/, "");
const live = (liveArg ?? "http://127.0.0.1:8770").replace(/\/$/, "");

function availableBytes(): number {
  const out = Bun.spawnSync(["vm_stat"]).stdout.toString();
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
  const pages = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
  return (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) * page;
}

function pressureLevel(): number {
  return Number(Bun.spawnSync(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"]).stdout.toString().trim()) || 0;
}

function rssBytes(pid: number | null): number | null {
  if (!pid) return null;
  const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]).stdout.toString().trim();
  return out ? Number(out) * 1024 : null;
}

async function liveChat(): Promise<{ contextLength: number | null; pid: number | null; state: string | null }> {
  try {
    const roles = await (await fetch(`${live}/stack/v1/roles`)).json() as { roles: Array<{ id: string; context_length?: number | null; state: { state: string } }> };
    const budget = await (await fetch(`${live}/stack/v1/hardware/budget`)).json() as { loaded: Array<{ id: string; pid: number | null }> };
    const chat = roles.roles.find((item) => item.id === "chat");
    return { contextLength: chat?.context_length ?? null, pid: budget.loaded.find((item) => item.id === "chat")?.pid ?? null, state: chat?.state.state ?? null };
  } catch {
    return { contextLength: null, pid: null, state: null };
  }
}

async function scratchRow(): Promise<{ pid: number | null; contextLength: number | null; slots: number | null; model: unknown; pictureTokensMax: number | null }> {
  if (enginePid !== null) return { pid: enginePid, contextLength: null, slots: null, model: modelId ?? null, pictureTokensMax: null };
  const budget = await (await fetch(`${scratch}/stack/v1/hardware/budget`)).json() as { loaded: Array<{ id: string; pid: number | null }> };
  const roles = await (await fetch(`${scratch}/stack/v1/roles`)).json() as { roles: Array<{ id: string; model: unknown; context_length?: number | null; slots?: number | null; picture_tokens_max?: number | null }> };
  const row = roles.roles.find((item) => item.id === role);
  return { pid: budget.loaded.find((item) => item.id === role)?.pid ?? null, contextLength: row?.context_length ?? null, slots: row?.slots ?? null, model: row?.model ?? null, pictureTokensMax: row?.picture_tokens_max ?? null };
}

const mime = extname(picture).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
const dataUrl = `data:${mime};base64,${readFileSync(picture).toString("base64")}`;

interface Timed { firstTextMs: number | null; totalMs: number; text: string; timings: Record<string, number> | null; promptTokens: number | null }
async function ask(withPicture: boolean, signal: AbortSignal): Promise<Timed> {
  const content = withPicture ? [{ type: "image_url", image_url: { url: dataUrl } }, { type: "text", text: question }] : question;
  const started = performance.now();
  const response = await fetch(`${scratch}/v1/chat/completions`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: modelId ?? role, stream: true, stream_options: { include_usage: true }, max_tokens: 160, messages: [{ role: "user", content }] }) });
  if (!response.ok || !response.body) throw new Error(`${role} answered HTTP ${response.status}: ${await response.text()}`);
  let firstTextMs: number | null = null; let text = ""; let timings: Record<string, number> | null = null; let promptTokens: number | null = null; let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/^data: /, ""); buffer = buffer.slice(index + 2);
      if (!line || line === "[DONE]") continue;
      const event = JSON.parse(line) as { choices?: Array<{ delta?: { content?: string } }>; timings?: Record<string, number>; usage?: { prompt_tokens?: number } };
      const delta = event.choices?.[0]?.delta?.content ?? "";
      if (delta && firstTextMs === null) firstTextMs = Math.round(performance.now() - started);
      text += delta;
      if (event.timings) timings = event.timings;
      if (event.usage?.prompt_tokens) promptTokens = event.usage.prompt_tokens;
    }
  }
  return { firstTextMs, totalMs: Math.round(performance.now() - started), text: text.trim(), timings, promptTokens };
}

const chatBefore = await liveChat();
const availableBefore = availableBytes();
const pressureBefore = pressureLevel();
let lowest = availableBefore;
let highestPressure = pressureBefore;
let warnSince: number | null = null;
let stopped: string | null = null;
let peakRss = 0;
let samplePid: number | null = null;
const abort = new AbortController();
const sampler = setInterval(() => {
  lowest = Math.min(lowest, availableBytes());
  const level = pressureLevel();
  highestPressure = Math.max(highestPressure, level);
  peakRss = Math.max(peakRss, rssBytes(samplePid) ?? 0);
  warnSince = level >= 2 ? warnSince ?? Date.now() : null;
  if (!stopped && (level >= 4 || (warnSince !== null && Date.now() - warnSince >= 3_000))) {
    stopped = `kernel pressure level ${level}`;
    abort.abort();
  }
}, 250);
const pidWatch = setInterval(async () => { samplePid = (await scratchRow().catch(() => null))?.pid ?? samplePid; }, 1_000);

const results: { cold?: Timed; warm?: Timed; textOnly?: Timed; error?: string } = {};
try {
  results.cold = await ask(true, abort.signal);
  results.warm = await ask(true, abort.signal);
  results.textOnly = await ask(false, abort.signal);
} catch (error) {
  results.error = (error as Error).message;
}
clearInterval(sampler);
clearInterval(pidWatch);
const row = await scratchRow();
if (stopped && enginePid !== null) process.kill(enginePid);
else if (stopped) {
  // The watchdog's stop: unload the role on the scratch Stack only.
  const loaded = typeof row.model === "object" && row.model ? (row.model as { id: string }).id : modelId;
  if (loaded) await fetch(`${scratch}/stack/v1/models/${loaded}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "unload" }) }).catch(() => undefined);
}
const availableAfter = availableBytes();
const chatAfter = await liveChat();
const scratchBudget = enginePid !== null ? null : await (await fetch(`${scratch}/stack/v1/hardware/budget`)).json();

console.log(JSON.stringify({
  at: new Date().toISOString(),
  role,
  picture: picture.split("/").pop(),
  question,
  stopped,
  memory: {
    availableBeforeBytes: availableBefore,
    availableLowestBytes: lowest,
    availableAfterBytes: availableAfter,
    dropAtLowestBytes: availableBefore - lowest,
    pressureBefore,
    highestPressure,
    pid: row.pid,
    processBytesNow: rssBytes(row.pid),
    processPeakBytes: peakRss || null,
  },
  launched: { contextLength: row.contextLength, slots: row.slots, pictureTokensMax: row.pictureTokensMax, model: row.model },
  liveChat: { before: chatBefore, after: chatAfter, contextUnchanged: chatBefore.contextLength === chatAfter.contextLength, pidUnchanged: chatBefore.pid === chatAfter.pid },
  latency: results,
  governor: scratchBudget,
}, null, 2));
