// Installs one shipped pin on a running Stack through its own model job
// (POST /stack/v1/models: the verified downloader, the expected sha256,
// the download cap), then waits for the job. Usage:
//   bun run scripts/install-pin.ts <pin id> [stack url]
// For the vision role, install the projector first, then the model:
//   bun run scripts/install-pin.ts qwen3-vl-4b-instruct-mmproj-q8-0
//   bun run scripts/install-pin.ts qwen3-vl-4b-instruct-q4-k-m
// The pin comes from the running Stack's own catalog route, so this
// script opens no database and reads no settings of its own.
import type { CatalogModelLike } from "@/lib/modelStore";

const id = process.argv[2];
const base = (process.argv[3] ?? "http://127.0.0.1:8770").replace(/\/$/, "");
const catalog = await (await fetch(`${base}/stack/v1/models/catalog`)).json() as { models: CatalogModelLike[] };
const pin = catalog.models.find((model) => model.id === id);
if (!pin?.download) {
  console.error(`No shipped pin named ${id ?? "(none)"}. Pins: ${catalog.models.map((model) => model.id).join(", ")}`);
  process.exit(1);
}
const body = { id: pin.id, role: pin.role, repo: pin.repo, url: pin.download.url, sha256: pin.download.sha256, approx_bytes: pin.download.approx_bytes, licence: pin.license, revision: pin.revision, engine: pin.engine, ...(pin.component ? { component: pin.component } : {}) };
const started = await fetch(`${base}/stack/v1/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
if (started.status !== 202) { console.error(`The Stack refused the install: HTTP ${started.status} ${await started.text()}`); process.exit(1); }
const { job } = await started.json() as { job: string };
console.log(`Installing ${pin.id} as job ${job}.`);
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const state = (await (await fetch(`${base}/stack/v1/jobs/${job}`)).json() as { job: { state: string; percent: number; status: string; reason: string | null } }).job;
  console.log(`${state.state} ${state.percent}% ${state.status}`);
  if (state.state === "done") break;
  if (state.state === "failed" || state.state === "cancelled") { console.error(state.reason ?? state.state); process.exit(1); }
}
