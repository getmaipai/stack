// Scratch Stack for proving the memory ladder (MEM-LADDER-01) and Home's restart (MEM-RETRY-01) end to end, with no model and no GPU.
// It serves the real routes (`app`) on its own port and data directory, with a scripted video worker (it runs for WORKER_SECONDS and stops when
// killed), the real watchdog on a sampler this script drives, and a stubbed Reduced swap. A control server on PORT+1:
//   /ctl/pressure?state=critical|normal   set what the sampler reads
//   /ctl/chat?idle=1|0                    whether chat counts as idle
//   /ctl/frees?on=1|0                     whether the Reduced swap frees enough memory (the next read is no longer critical)
//   /ctl/status                           the watchdog's recent actions, the reduced state, the video jobs
// Run: STACK_DATA_DIR=<scratch dir> PORT=<port> bun run scripts/prove-memory-ladder.ts   (never 3000, 8770 or 8787)
import { writeFileSync } from "node:fs";
import { app, websocket } from "@/app";
import { __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { listJobs } from "@/lib/jobs";
import { startMemoryWatchdog, memoryWatchdog } from "@/lib/memoryWatchdog";
import { __setReducedLeaseForTests } from "@/lib/reducedChatLease";
import { getReducedChatState, setReducedChatState } from "@/lib/reducedChat";
import { registerVideoJobs } from "@/video/jobs";
import { videoGen, type VideoGenDeps, type WorkerHandle, type WorkerReply } from "@/video/videoGen";
import type { SystemSample, SystemSampler } from "@/lib/memory/system";

const port = Number(process.env.PORT);
const dataDir = process.env.STACK_DATA_DIR ?? "";
if (!port || [3000, 8770, 8787].includes(port) || !dataDir.startsWith("/tmp/") && !dataDir.includes("scratch")) { console.error("Set PORT (not 3000, 8770 or 8787) and STACK_DATA_DIR to a scratch directory."); process.exit(2); }
const GB = 1_073_741_824;
const WORKER_SECONDS = Number(process.env.WORKER_SECONDS ?? 90);
const ctl = { state: "normal" as "normal" | "critical", chatIdle: true, frees: false };

const sample = (): SystemSample => ctl.state === "critical"
  ? { at: Date.now(), totalBytes: 128 * GB, availableBytes: 2 * GB, freeBytes: GB, wiredBytes: 30 * GB, compressorBytes: GB, swapUsedBytes: 4 * GB, swapTotalBytes: 8 * GB, pressureLevel: 4, pressure: "critical", degraded: false }
  : { at: Date.now(), totalBytes: 128 * GB, availableBytes: 98 * GB, freeBytes: 60 * GB, wiredBytes: 30 * GB, compressorBytes: GB, swapUsedBytes: GB, swapTotalBytes: 8 * GB, pressureLevel: 1, pressure: "normal", degraded: false };
const sampler: SystemSampler = { sample, processes: () => [], cwds: () => new Map(), hasClient: () => false };

const scripted: VideoGenDeps = {
  supported: () => true,
  ensureEnvironment: async () => {},
  paths: () => ({ modelDir: "/models/video", tokenizerDir: "/models/tok" }),
  spawn: async (): Promise<WorkerHandle> => {
    let end!: (code: number) => void;
    const exited = new Promise<number>((done) => { end = done; });
    return {
      exited,
      kill: () => end(143),
      send: async (request, options) => {
        const started = Date.now();
        const run = (async (): Promise<WorkerReply> => {
          for (let second = 0; second < WORKER_SECONDS; second++) {
            options.onEvent({ id: request.id, event: "phase", phase: "rendering", percent: Math.min(99, Math.round((second / WORKER_SECONDS) * 100)) });
            await new Promise((r) => setTimeout(r, 1000));
          }
          writeFileSync(request.output, Buffer.concat([Buffer.from([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), Buffer.alloc(4096, 7)]));
          writeFileSync(request.poster, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 9)]));
          return { id: request.id, ok: true, width: request.width, height: request.height, frames: request.num_frames, fps: 24, seed: request.seed, ms: Date.now() - started, peak_bytes: 44_000_000_000 };
        })();
        return Promise.race([run, exited.then(() => ({ id: request.id, ok: false, code: "worker_stopped", error: "The video engine stopped before the clip was finished. Try again." }) as WorkerReply)]);
      },
    };
  },
};

__setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
videoGen.useDeps(scripted);
registerVideoJobs();
__setReducedLeaseForTests({ deps: {
  enter: async () => { setReducedChatState("reduced"); if (ctl.frees) ctl.state = "normal"; return { ok: true, swapMs: 10 }; },
  leave: async () => { setReducedChatState("off"); return { ok: true, swapMs: 10 }; },
} });
startMemoryWatchdog({ sampler, chatIdle: () => ctl.chatIdle, chatLoaded: () => true });

// The scratch Stack has no model files, so its status route would say "not installed" and Home would refuse to start a clip. This one wrapper marks the
// Quick model installed in that one answer; every job route below it is the real code.
const serveApp = async (request: Request, server: unknown): Promise<Response> => {
  const url = new URL(request.url);
  const response = await (app.fetch as (r: Request, s: unknown) => Promise<Response>)(request, server);
  if (request.method !== "GET" || url.pathname !== "/stack/v1/video" || !response.ok) return response;
  const body = await response.json() as { video: { state: string; model: { installed: boolean }; qualities?: Record<string, { installed: boolean; available: boolean }> } };
  body.video.state = "idle"; body.video.model.installed = true;
  for (const quality of Object.values(body.video.qualities ?? {})) { quality.installed = true; quality.available = true; }
  return Response.json(body);
};
Bun.serve({ port, hostname: "127.0.0.1", fetch: serveApp as never, websocket, idleTimeout: 255 });
Bun.serve({ port: port + 1, hostname: "127.0.0.1", fetch: (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/ctl/pressure") ctl.state = url.searchParams.get("state") === "critical" ? "critical" : "normal";
  if (url.pathname === "/ctl/chat") ctl.chatIdle = url.searchParams.get("idle") !== "0";
  if (url.pathname === "/ctl/frees") ctl.frees = url.searchParams.get("on") === "1";
  const report = memoryWatchdog().report();
  return Response.json({ ctl, reduced: getReducedChatState(), level: report.watchdog.level, actions: report.recent_actions.map((a) => `${a.at.slice(11, 19)} ${a.action} ${a.detail}`), jobs: listJobs().map((job) => ({ id: job.id, kind: job.kind, state: job.state, status: job.status })) });
} });
console.log(`scratch Stack on ${port}, control on ${port + 1}, data ${dataDir}`);
