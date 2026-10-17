// GENPREVIEW-01: what a picture or clip job is doing, in stages, for the job
// status routes. A worker reports the stage it is in (and, inside a stage, "n of
// m"); this turns that into one overall fraction (0..1) weighted by where the
// time really goes, a person-words label for the stage, and an ETA from the
// medians of past runs of the same kind and size (kept in data/gen-history.json,
// numbers only: no prompt, no picture, rule 6a). Previews are files the worker
// writes in the job's own work folder; this module only remembers which version
// is the latest. Nothing here is a new status surface: the routes that already
// answer for the job carry the fields.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";

export interface StageDef {
  id: string;
  /** Share of a typical run (weights sum to 1), measured on the Studio. */
  weight: number;
  /** Typical seconds, used until the Stack has its own history. */
  seconds: number;
  label: (n: number | null, of: number | null) => string;
}

export type GenKind = "image" | "video";

/** Video stages. Weights and seconds are the medians of measured runs (832x480, 5 s, 128 GB Mac); see the design note "Stack API as built". */
export const VIDEO_STAGES: StageDef[] = [
  { id: "load_text", weight: 0.03, seconds: 3, label: () => "Getting ready" },
  { id: "plan", weight: 0.01, seconds: 1, label: () => "Planning the scene" },
  { id: "load_model", weight: 0.02, seconds: 2, label: () => "Loading the video model" },
  { id: "motion", weight: 0.09, seconds: 12, label: (n, of) => (n !== null && of ? `Making the motion, step ${Math.min(n + 1, of)} of ${of}` : "Making the motion") },
  { id: "frames", weight: 0.83, seconds: 112, label: (n, of) => (n !== null && of ? `Putting the frames together, ${Math.min(n + 1, of)} of ${of}` : "Putting the frames together") },
  { id: "save", weight: 0.02, seconds: 2, label: () => "Saving the video" },
];

export const IMAGE_STAGES: StageDef[] = [
  { id: "load", weight: 0.1, seconds: 0.5, label: () => "Loading the picture model" },
  { id: "plan", weight: 0.15, seconds: 0.6, label: () => "Reading your request" },
  { id: "steps", weight: 0.65, seconds: 2.6, label: (n, of) => (n !== null && of ? `Drawing, step ${Math.min(n + 1, of)} of ${of}` : "Drawing") },
  { id: "decode", weight: 0.1, seconds: 0.4, label: () => "Finishing the picture" },
];

export const stagesFor = (kind: GenKind): StageDef[] => (kind === "video" ? VIDEO_STAGES : IMAGE_STAGES);

// ---- history: the last few stage durations per kind and size ----

const HISTORY_KEEP = 7;
type History = Record<string, Record<string, number[]>>;
const historyFile = (): string => join(dataDir, "gen-history.json");
let cache: History | null = null;
function loadHistory(): History {
  if (cache) return cache;
  try { cache = JSON.parse(readFileSync(historyFile(), "utf8")) as History; } catch { cache = {}; }
  return cache!;
}
export function __resetGenHistoryForTests(): void { cache = null; }
export const historyKey = (kind: GenKind, width: number, height: number, frames?: number): string => `${kind}:${width}x${height}${frames ? `x${frames}` : ""}`;
const median = (values: number[]): number => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]!; };

/** Median seconds of a stage for this kind and size, or the typical number when there is no history yet. */
export function stageSeconds(key: string, stage: StageDef): number {
  const seen = loadHistory()[key]?.[stage.id];
  return seen && seen.length > 0 ? median(seen) : stage.seconds;
}
export function recordRun(key: string, seconds: Record<string, number>): void {
  const history = loadHistory();
  const entry = (history[key] ??= {});
  for (const [stage, value] of Object.entries(seconds)) {
    if (!(value > 0)) continue;
    entry[stage] = [...(entry[stage] ?? []), Math.round(value * 10) / 10].slice(-HISTORY_KEEP);
  }
  try {
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${historyFile()}.tmp`;
    writeFileSync(tmp, JSON.stringify(history), { mode: 0o600 });
    renameSync(tmp, historyFile());
  } catch { /* the history is a nicety; a read-only disk loses an estimate, never a job */ }
}

// ---- one job's tracker ----

export interface GenSnapshot {
  stage: string | null;
  stage_label: string | null;
  step: number | null;
  steps: number | null;
  /** 0..1 over the whole job. */
  fraction: number;
  /** Whole seconds left, or null before a stage is known. */
  eta_seconds: number | null;
}

export class GenTracker {
  private index = -1;
  private n: number | null = null;
  private of: number | null = null;
  private stageStarted = 0;
  private readonly spent: Record<string, number> = {};
  private seenStage = false;
  /** Several pictures in one job: which one is being made, and how many. Each runs the stages again. */
  private unit = 0;
  private units = 1;
  /** The bar never goes back, and the countdown never grows without a measured reason. */
  private high = 0;
  private lastEta: { value: number; at: number } | null = null;
  /** The latest preview: a version that changes with every new file, and the step it shows. */
  preview: { version: number; step: number | null; steps: number | null } | null = null;
  private readonly stages: StageDef[];
  constructor(readonly kind: GenKind, readonly key: string, private readonly now: () => number = Date.now) { this.stages = stagesFor(kind); }

  get started(): boolean { return this.seenStage; }

  /** The worker says which stage it is in. Earlier stages are closed; a stage that is skipped (no reference picture, a loaded model) counts as done. */
  enter(stageId: string, n: number | null = null, of: number | null = null): void {
    const next = this.stages.findIndex((stage) => stage.id === stageId);
    if (next < 0) return;
    this.seenStage = true;
    const at = this.now();
    if (next !== this.index) {
      if (this.index >= 0) this.spent[this.stages[this.index]!.id] = (this.spent[this.stages[this.index]!.id] ?? 0) + (at - this.stageStarted) / 1000;
      // A stage never goes backwards: a late "plan" line after "motion" began is ignored.
      if (next < this.index) return;
      this.index = next;
      this.stageStarted = at;
    }
    this.n = n; this.of = of;
  }

  /** The next picture of a job that makes several starts over at the first stage. */
  nextUnit(unit: number, units: number): void {
    if (unit === this.unit && units === this.units) return;
    if (this.index >= 0) this.spent[this.stages[this.index]!.id] = (this.spent[this.stages[this.index]!.id] ?? 0) + (this.now() - this.stageStarted) / 1000;
    this.unit = unit; this.units = units; this.index = -1; this.n = null; this.of = null; this.stageStarted = this.now();
  }

  setPreview(step: number | null, steps: number | null): void {
    this.preview = { version: (this.preview?.version ?? 0) + 1, step, steps };
  }

  /** Seconds each stage took in this run, for the history; the open stage counts up to now. */
  finish(): Record<string, number> {
    if (this.index >= 0) this.spent[this.stages[this.index]!.id] = (this.spent[this.stages[this.index]!.id] ?? 0) + (this.now() - this.stageStarted) / 1000;
    return { ...this.spent };
  }

  snapshot(): GenSnapshot {
    if (this.index < 0) return { stage: null, stage_label: null, step: null, steps: null, fraction: this.unit / this.units, eta_seconds: null };
    const stage = this.stages[this.index]!;
    const elapsed = (this.now() - this.stageStarted) / 1000;
    const typical = Math.max(0.5, stageSeconds(this.key, stage));
    // Inside a stage: the worker's own "n of m" when it gives one, else time against the stage's median, never reaching the end by itself.
    const reported = this.n !== null && this.of ? Math.max(0, Math.min(1, this.n / this.of)) : null;
    const inner = reported ?? Math.min(0.95, elapsed / typical);
    const before = this.stages.slice(0, this.index).reduce((sum, item) => sum + item.weight, 0);
    const unitFraction = before + stage.weight * inner;
    const fraction = (this.high = Math.max(this.high, Math.min(0.99, (this.unit + unitFraction) / this.units)));
    // Remaining time: later stages at their medians, this stage by its own pace once it has shown 15 percent.
    const later = this.stages.slice(this.index + 1).reduce((sum, item) => sum + stageSeconds(this.key, item), 0);
    const here = reported !== null && reported >= 0.15 && elapsed > 0 ? (elapsed * (1 - reported)) / reported : Math.max(0.5, typical * (1 - inner));
    const raw = here + later + (this.units - this.unit - 1) * this.stages.reduce((sum, item) => sum + stageSeconds(this.key, item), 0);
    const at = this.now();
    // The countdown runs down with the clock; it grows only once the stage's own measured pace says the run is slower than usual.
    const expected = this.lastEta ? this.lastEta.value - (at - this.lastEta.at) / 1000 : raw;
    const eta = Math.max(1, Math.round(raw <= expected || (reported !== null && reported >= 0.15) ? raw : Math.max(expected, 1)));
    this.lastEta = { value: eta, at };
    return {
      stage: stage.id, stage_label: stage.label(this.n, this.of), step: stage.id === "steps" || stage.id === "motion" ? this.n : null, steps: stage.id === "steps" || stage.id === "motion" ? this.of : null,
      fraction, eta_seconds: eta,
    };
  }
}

// ---- previews: one JPEG a worker overwrites in the job's work folder ----

export const PREVIEW_NAME = "preview.jpg";
export function previewFile(work: string): string { return join(work, PREVIEW_NAME); }
export function previewExists(work: string): boolean { return existsSync(previewFile(work)); }
