import { StackStatus, type StackStatus as StackStatusType } from "@maipai/spec/stack/ts/stack-status.js";
import { list as listHealth } from "@/lib/health";
import { listJobs } from "@/lib/jobs";
import { getGovernorStatus } from "@/lib/governor";
import { memoryLevel } from "@/lib/memoryState";
import { partDef } from "@/lib/partDefs";
import { componentIdOfFailureCode, DISK_MARGIN_BYTES } from "@/lib/components";
import { detectHardware, type HardwareInfo } from "@/lib/hardware";
import { ROLE_IDS, type RoleId } from "@/roles";
import { selectedModel } from "@/lib/supervisor";
import { updateInProgress } from "@/updates/engines";

const NO_FIX = "The Stack is watching this; nothing to press yet.";
let diskFirstSeen: string | null = null;
let hardwareOverride: HardwareInfo | null = null;
export function __resetStackStatusForTests(): void { diskFirstSeen = null; }
export function __setStatusHardwareForTests(hw: HardwareInfo | null): void { hardwareOverride = hw; }

export async function stackStatus(hw?: HardwareInfo): Promise<StackStatusType> {
  const hardware = hw ?? hardwareOverride ?? await detectHardware();
  const governor = getGovernorStatus();
  const jobs = listJobs();
  const healthItems = listHealth();
  const pressure = memoryLevel();
  const jobRows = jobs.slice(0, 50).map((job) => {
    const model = typeof job.input?.model === "string" ? job.input.model : null;
    const component = typeof job.input?.component === "string" ? job.input.component : null;
    const candidate = model ?? component;
    const state = job.state === "running" ? "running" : ["queued", "stalled", "paused", "waiting_for_you"].includes(job.state) ? "waiting" : ["failed", "cancelled"].includes(job.state) ? "failed" : job.state === "done" ? "done" : "failed";
    return { id: job.id, kind: job.kind, part_id: candidate && partDef(candidate) ? candidate : null, state, reason: state === "waiting" || state === "failed" ? (job.reason ?? job.status ?? null) : null, percent: job.percent ?? null };
  });
  const using = governor.loaded.flatMap((entry) => {
    if (!partDef(entry.id)) return [];
    const active = jobs.find((job) => job.state === "running" && (job.input?.model === entry.id || job.input?.component === entry.id));
    return [{ part_id: entry.id, bytes: entry.liveBytes ?? entry.peakBytes, job_id: active?.id ?? null }];
  });
  const problems = healthItems.map((item) => {
    const component = componentIdOfFailureCode(item.code);
    let partId = component && partDef(component) ? component : null;
    if (!partId) {
      const suffix = item.code.split(".").at(-1) ?? "";
      if (ROLE_IDS.includes(suffix as RoleId)) { const model = selectedModel(suffix as RoleId)?.id; if (model && partDef(model)) partId = model; }
    }
    return { code: item.code, part_id: partId, plain: item.text?.trim() ? item.text : item.title, fix: item.fix?.label ?? NO_FIX, since: item.since };
  });
  if (typeof hardware.freeDiskBytes === "number" && hardware.freeDiskBytes < DISK_MARGIN_BYTES) {
    diskFirstSeen ??= new Date().toISOString();
    const freeGb = Math.round(hardware.freeDiskBytes / 1_000_000_000);
    problems.push({ code: "disk-full", part_id: null, plain: `The disk is nearly full: about ${freeGb} GB free. Downloads and new pictures will fail.`, fix: "Free space on this disk, or remove a part you do not use from Settings.", since: diskFirstSeen });
  } else diskFirstSeen = null;
  const down = healthItems.some((item) => ["engine.crashed.chat", "managed-host-offline.chat", "post-load-check-failed.chat"].includes(item.code));
  const hasError = healthItems.some((item) => item.severity === "error" || item.severity === "critical");
  const health = updateInProgress() ? "updating" : down ? "down" : hasError || pressure === "critical" || problems.some((item) => item.code === "disk-full") ? "degraded" : "ok";
  return StackStatus.parse({
    health,
    busy: { running: jobRows.filter((job) => job.state === "running").length, waiting: jobRows.filter((job) => job.state === "waiting").length + governor.queue.length },
    using,
    memory: { total_bytes: governor.totalMemoryBytes, free_bytes: governor.freeMemoryBytes, budget_bytes: governor.capBytes, pressure },
    jobs: jobRows,
    problems,
  });
}
