import "./lib/stackAuth";
export {};
const usage = "Usage: bun run scripts/resource-recapture-bench.ts --stack http://127.0.0.1:8770 --kind picture|video|music|stems|all [--wait-seconds N]";
const args = process.argv.slice(2);
if (args.includes("--help") || args.length === 0) { console.log(usage); process.exit(0); }
const value = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const stack = value("--stack");
const kind = value("--kind");
if (!stack || !["picture", "video", "music", "stems", "all"].includes(kind ?? "")) { console.error(usage); process.exit(2); }

// `heldBytes` is the governor ledger's warm plus burst bytes (what a finished job leaves loaded); `unregistered` counts processes below the
// Stack that no job or role owns; `stackBytes` is informational because the chat engine and the other residents grow with ordinary use.
type Reading = { heldBytes: number; unregistered: number; stackBytes: number; unaccounted: number; tmp: number };
async function read(): Promise<Reading> {
  const response = await fetch(`${stack}/stack/v1/memory`);
  if (!response.ok) throw new Error(`Memory route returned ${response.status}`);
  const report = await response.json() as any;
  return { heldBytes: report.ledger.warm_bytes + report.ledger.burst_bytes, unregistered: report.stack.unregistered.count, stackBytes: report.stack.bytes, unaccounted: report.stack.unaccounted_bytes, tmp: report.stack.tmp_bytes };
}
const jobs: Record<string, { path: string; body: unknown; ttl: number }> = {
  picture: { path: "/v1/images/generations", body: { prompt: "A small blue square", size: "256x256", n: 1, steps: 1, timeout_ms: 30 * 60_000 }, ttl: 600_000 },
  video: { path: "/v1/videos/generations", body: { prompt: "A short blue square", model: "quick", size: "256x256", seconds: 1, timeout_ms: 30 * 60_000 }, ttl: 600_000 },
  music: { path: "/v1/audio/music", body: { task: "text2music", caption: "instrumental", instrumental: true, duration_s: 5, timeout_ms: 30 * 60_000 }, ttl: 300_000 },
  stems: { path: "/v1/audio/stems", body: null, ttl: 60_000 },
};
const rows: Array<{ kind: string; before: Reading; after: Reading }> = [];
for (const selected of kind === "all" ? Object.keys(jobs) : [kind!]) {
  if (selected === "stems") throw new Error("stems needs an existing Stack-made song; supply it through the Stack before running this bench");
  const job = jobs[selected]!;
  const before = await read();
  const response = await fetch(`${stack}${job.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job.body) });
  if (!response.ok) throw new Error(`${selected} job submission returned ${response.status}: ${await response.text()}`);
  const result = await response.json() as any;
  let id = result.job;
  if (response.status === 202 && id) {
    const statusPath = selected === "picture" ? `/v1/images/generations/${id}` : selected === "video" ? `/v1/videos/generations/${id}` : `/v1/audio/music/${id}`;
    for (;;) {
      await Bun.sleep(1000);
      const status = await (await fetch(`${stack}${statusPath}`)).json() as any;
      if (["done", "failed", "cancelled"].includes(status.state)) { if (status.state !== "done") throw new Error(`${selected} job ended ${status.state}`); break; }
    }
  }
  // The worker's real idle time (picture and video 10 minutes, music 5, stems 1) plus ten seconds, or --wait-seconds.
  await Bun.sleep(value("--wait-seconds") ? Number(value("--wait-seconds")) * 1000 : job.ttl + 10_000);
  const after = await read();
  rows.push({ kind: selected, before, after });
}
console.log("kind | measure | before | after | difference");
let failed = false;
for (const row of rows) for (const key of ["heldBytes", "unregistered", "unaccounted", "tmp", "stackBytes"] as const) {
  const delta = row.after[key] - row.before[key];
  console.log(`${row.kind} | ${key} | ${row.before[key]} | ${row.after[key]} | ${delta}`);
  const limit = key === "unregistered" ? 0 : key === "heldBytes" ? 256 * 1024 ** 2 : key === "unaccounted" ? 512 * 1024 ** 2 : key === "tmp" ? 16 * 1024 ** 2 : Infinity;
  if (delta > limit) failed = true;
}
process.exit(failed ? 1 : 0);
