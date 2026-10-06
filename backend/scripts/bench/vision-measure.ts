// VISION-01b's measurement: what the vision role costs on this machine
// beside a resident chat, read from a real load and a real picture.
// Usage (a scratch Stack with the vision pins installed; the live Stack
// is read only):
//   bun run scripts/bench/vision-measure.ts <picture> "<question>" \
//     [scratch stack url] [live stack url]
// It prints one JSON object: whole-machine available memory before,
// at its lowest while vision loads and encodes, and after; the vision
// process's resident set; the live chat's context and pid before and
// after (rule 4: unchanged); first-text latency cold and warm, and a
// text-only request on the same engine, with the engine's own timings.
// Available memory is free plus inactive plus speculative pages, the
// governor's own reading; a process footprint alone misses the weights
// the engine maps, so the whole-machine drop is the honest cost.
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const [picture, question, scratchArg, liveArg] = process.argv.slice(2);
if (!picture || !question) { console.error("usage: vision-measure.ts <picture> <question> [scratch url] [live url]"); process.exit(1); }
const scratch = (scratchArg ?? "http://127.0.0.1:8791").replace(/\/$/, "");
const live = (liveArg ?? "http://127.0.0.1:8770").replace(/\/$/, "");

function availableBytes(): number {
  const out = Bun.spawnSync(["vm_stat"]).stdout.toString();
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
  const pages = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
  return (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) * page;
}

function rssBytes(pid: number | null): number | null {
  if (!pid) return null;
  const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]).stdout.toString().trim();
  return out ? Number(out) * 1024 : null;
}

async function liveChat(): Promise<{ contextLength: number | null; pid: number | null }> {
  const roles = await (await fetch(`${live}/stack/v1/roles`)).json() as { roles: Array<{ id: string; context_length?: number | null }> };
  const budget = await (await fetch(`${live}/stack/v1/hardware/budget`)).json() as { loaded: Array<{ id: string; pid: number | null }> };
  return { contextLength: roles.roles.find((role) => role.id === "chat")?.context_length ?? null, pid: budget.loaded.find((item) => item.id === "chat")?.pid ?? null };
}

async function visionPid(): Promise<number | null> {
  const budget = await (await fetch(`${scratch}/stack/v1/hardware/budget`)).json() as { loaded: Array<{ id: string; pid: number | null }> };
  return budget.loaded.find((item) => item.id === "vision")?.pid ?? null;
}

const mime = extname(picture).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
const dataUrl = `data:${mime};base64,${readFileSync(picture).toString("base64")}`;

interface Timed { firstTextMs: number | null; totalMs: number; text: string; timings: Record<string, number> | null }
async function ask(withPicture: boolean): Promise<Timed> {
  const content = withPicture ? [{ type: "image_url", image_url: { url: dataUrl } }, { type: "text", text: question }] : question;
  const started = performance.now();
  const response = await fetch(`${scratch}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "vision", stream: true, max_tokens: 160, messages: [{ role: "user", content }] }) });
  if (!response.ok || !response.body) throw new Error(`vision answered HTTP ${response.status}: ${await response.text()}`);
  let firstTextMs: number | null = null; let text = ""; let timings: Record<string, number> | null = null; let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/^data: /, ""); buffer = buffer.slice(index + 2);
      if (!line || line === "[DONE]") continue;
      const event = JSON.parse(line) as { choices?: Array<{ delta?: { content?: string } }>; timings?: Record<string, number> };
      const delta = event.choices?.[0]?.delta?.content ?? "";
      if (delta && firstTextMs === null) firstTextMs = Math.round(performance.now() - started);
      text += delta;
      if (event.timings) timings = event.timings;
    }
  }
  return { firstTextMs, totalMs: Math.round(performance.now() - started), text: text.trim(), timings };
}

const chatBefore = await liveChat();
const availableBefore = availableBytes();
let lowest = availableBefore;
const sampler = setInterval(() => { lowest = Math.min(lowest, availableBytes()); }, 200);
const cold = await ask(true);
lowest = Math.min(lowest, availableBytes());
const pid = await visionPid();
const visionRss = rssBytes(pid);
const warm = await ask(true);
const textOnly = await ask(false);
clearInterval(sampler);
const availableAfter = availableBytes();
const chatAfter = await liveChat();
const scratchBudget = await (await fetch(`${scratch}/stack/v1/hardware/budget`)).json();
const roles = await (await fetch(`${scratch}/stack/v1/roles`)).json() as { roles: Array<{ id: string; model: unknown }> };

console.log(JSON.stringify({
  at: new Date().toISOString(),
  picture: picture.split("/").pop(),
  question,
  memory: {
    availableBeforeBytes: availableBefore,
    availableLowestBytes: lowest,
    availableAfterBytes: availableAfter,
    dropAtLowestBytes: availableBefore - lowest,
    visionPid: pid,
    visionRssBytes: visionRss,
  },
  chat: { before: chatBefore, after: chatAfter, contextUnchanged: chatBefore.contextLength === chatAfter.contextLength, pidUnchanged: chatBefore.pid === chatAfter.pid },
  latency: { cold, warm, textOnly },
  visionRole: roles.roles.find((role) => role.id === "vision")?.model ?? null,
  governor: scratchBudget,
}, null, 2));
