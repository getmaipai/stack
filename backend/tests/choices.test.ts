// The choices API (docs/dev/choices.md): one read for the AI and models page, a pick per category and level, the order, the recommended
// setup, what is unused, add-a-model-and-use-it and the one-time import of Home's values. The hardware probe, the installs, the link reader
// and the parts list are injected; the settings, the part order and the choices store are the real ones.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import { app } from "@/app";
import { __resetChoicesForTests } from "@/lib/choicesStore";
import { __setChoicesDepsForTests } from "@/lib/choices";
import { ChoicesViewSchema, type CategoryId } from "@/lib/choicesSchema";
import { NOT_YET_PARTS, plainQuantization, versionOf } from "@/lib/candidateInfo";
import { __resetPartChoicesForTests } from "@/lib/partChoices";
import { partDef } from "@/lib/partDefs";
import { TIER_CANDIDATES } from "@/lib/tiers";
import { __resetSettingsForTests, settingValues } from "@/settings";
import { isRoleDisabled } from "@/lib/roleSwitches";
import { __setProfileDepsForTests } from "@/routes/profiles";
import { STACK_MODELS } from "@/lib/modelCatalog";
import type { HardwareInfo } from "@/lib/hardware";

const hw = (gb: number): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: gb, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: gb, cudaDevices: [], freeDiskBytes: 1e12, osVersion: "test" });
let memory = 128;
let installedParts: Record<string, number> = {};
let partInstalls: string[] = [];
let pinInstalls: string[] = [];
let removed: string[] = [];
let inspected: Record<string, unknown> | null = null;

beforeEach(() => {
  memory = 128; installedParts = {}; partInstalls = []; pinInstalls = []; removed = []; inspected = null;
  __resetSettingsForTests(); __resetChoicesForTests(); __resetPartChoicesForTests();
  __setChoicesDepsForTests({
    probe: async () => hw(memory),
    installPart: async (id) => { partInstalls.push(id); return { job: `job-${id}` }; },
    installPin: async (pin) => { pinInstalls.push(pin.id); return { job: `pin-${pin.id}`, done: Promise.resolve() }; },
    inspect: async () => { if (!inspected) throw new Error("no link"); return inspected as never; },
    parts: async (hardware) => {
      const { listParts } = await import("@/lib/partsList");
      return (await listParts({ audience: "adult" }, hardware)).parts.map((part): StackPartView => installedParts[part.id] ? { ...part, state: "ready", size_bytes: installedParts[part.id]!, download_bytes: 0, can_uninstall: true, uninstall_block: null, required_by: [] } : part);
    },
    uninstallPart: async (id) => { removed.push(id); return { component: id, freed_bytes: installedParts[id] ?? 0, removed: true } as never; },
  });
  __setProfileDepsForTests({ probe: async () => hw(memory), install: async (pin) => ({ job: `job-${pin.id}`, done: Promise.resolve() }) });
});
afterEach(() => { __setChoicesDepsForTests(null); __setProfileDepsForTests(null); __resetSettingsForTests(); __resetChoicesForTests(); __resetPartChoicesForTests(); });

const call = (method: string, path: string, body?: unknown) => app.request(`/stack/v1/choices${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
type Level = { tier: string; chosen_state: string | null; chosen: string | null; chosen_by: string; problem: string | null; customization: unknown; options: Array<{ model: string; fits: boolean; refusal: string | null }>; recommended: { model: string | null; why: string } };
type Cat = { id: CategoryId; order: string[]; disabled: string[]; available: boolean; role_enabled: boolean | null; tiers: Level[]; candidates: Array<Record<string, unknown> & { id: string; state: string; kind: string; label: string; summary: string }>; profiles: Array<{ profile: string; current: boolean; assignments: Array<{ tier: string; model: string }> }> };
const read = async () => (await (await call("GET", "")).json()) as { profile: string | null; categories: Cat[]; unused: { count: number; total_bytes: number }; migration: { done: boolean; accepted: number; refused: number } };
const cat = async (id: CategoryId) => (await read()).categories.find((item) => item.id === id)!;
const level = async (id: CategoryId, tier: string) => (await cat(id)).tiers.find((row) => row.tier === tier)!;

test("the read answers every category with levels, candidates and recommended picks, in the declared shape", async () => {
  const res = await call("GET", "");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(ChoicesViewSchema.safeParse(body).success).toBe(true);
  const view = body as Awaited<ReturnType<typeof read>>;
  expect(view.profile).toBe("p128");
  expect(view.categories.map((item) => item.id)).toEqual(["chat", "coding", "pictures", "video", "music", "voice", "stt", "embeddings", "vision", "wakeword", "stems"]);
  const chat = view.categories.find((item) => item.id === "chat")!;
  expect(chat.tiers.map((row) => row.tier)).toEqual(["reduced", "standard", "boost", "max"]);
  expect(chat.tiers.find((row) => row.tier === "standard")).toMatchObject({ chosen: "qwen3-8b-instruct-q4-k-m", chosen_by: "recommended" });
  expect(chat.tiers.find((row) => row.tier === "standard")!.recommended.why).toContain("fits this computer");
  expect(view.categories.find((item) => item.id === "voice")!.tiers.map((row) => row.tier)).toEqual(["reduced", "standard"]);
  expect(view.categories.find((item) => item.id === "stt")!.tiers.map((row) => row.tier)).toEqual(["standard"]);
  // No Wan for an adult list: the recommended video model is one the list carries.
  const video = view.categories.find((item) => item.id === "video")!;
  expect(video.candidates.some((candidate) => candidate.id === "fastwan2-2-ti2v-5b-mlx-bf16")).toBe(false);
  expect(video.tiers[0]!.recommended.model).not.toBe("fastwan2-2-ti2v-5b-mlx-bf16");
  expect(chat.role_enabled).toBe(true);
  expect(view.migration.done).toBe(false);
});

test("a candidate carries its plain facts and one searchable string", async () => {
  const chat = await cat("chat");
  const flash = chat.candidates.find((candidate) => candidate.id === "qwen3-8-flash-next-177b-huihui-abliterated-iq4-xs")!;
  expect(flash).toMatchObject({
    label: "Qwen3.8 Flash Next 177B (Huihui)", family: "qwen3.8", version: "3.8", quantization: "4-bit, extra compact", quantization_raw: "UD-IQ4_XS", license: "qwen-community-1.0",
    repo: "huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-v2-GGUF", engine: "splash", role: "chat", min_profile: "A 128 GB computer or bigger", min_profile_id: "p128", kind: "shipped", state: "notInstalled",
  });
  expect(String(flash.summary)).toContain("biggest chat model");
  expect(Number(flash.size_bytes)).toBeGreaterThan(50_000_000_000);
  const text = String(flash.search_text);
  for (const word of ["flash next", "qwen3-8-flash-next-177b", "huihui-ai", "qwen3.8", "extra compact", "ud-iq4_xs", "qwen-community", "biggest chat model", "splash", "chat"]) expect(text).toContain(word);
  expect(plainQuantization("Q4_K_M")).toBe("4-bit, compact");
  expect(plainQuantization("bf16, run 8-bit")).toBe("Full-quality files, run as 8-bit to save memory");
  expect(versionOf("Qwen3 8B", "qwen3")).toBe("3");
  expect(versionOf("Z-Image-Turbo", "z-image")).toBeNull();
});

test("every model in the tier table has a plain label and summary", async () => {
  for (const id of new Set(TIER_CANDIDATES.map((row) => row.id))) {
    const label = partDef(id)?.label ?? NOT_YET_PARTS[id]?.label;
    const summary = partDef(id)?.description ?? NOT_YET_PARTS[id]?.summary;
    expect(label, `${id} has no label`).toBeTruthy();
    expect(summary, `${id} has no summary`).toBeTruthy();
    expect(summary!.endsWith("."), `${id} summary is not a sentence`).toBe(true);
  }
  // The same on the wire, for every profile the table reaches: no candidate prints its id or an empty sentence.
  for (const gbs of [16, 32, 64, 128]) {
    memory = gbs;
    for (const category of (await read()).categories) for (const candidate of category.candidates) {
      expect(candidate.label.length, `${candidate.id} label`).toBeGreaterThan(0);
      expect(candidate.label, `${candidate.id} label is its id`).not.toBe(candidate.id);
      expect(candidate.summary.length, `${candidate.id} summary`).toBeGreaterThan(8);
      expect(String(candidate.search_text)).toContain(candidate.id);
    }
  }
});

test("a pick is validated, stored and read back; it starts the download first and a clear returns to the recommended model", async () => {
  const before = await level("chat", "boost");
  expect(before.chosen_by).toBe("recommended");
  const res = await call("PUT", "/chat/boost", { model: "qwen3.8-27b-ud-q4-k-m" });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, category: "chat", tier: "boost", profile: "p128", model: "qwen3.8-27b-ud-q4-k-m", changed: true, install_job: "job-qwen3.8-27b-ud-q4-k-m" });
  expect(partInstalls).toEqual(["qwen3.8-27b-ud-q4-k-m"]);
  expect(await level("chat", "boost")).toMatchObject({ chosen: "qwen3.8-27b-ud-q4-k-m", chosen_by: "household" });
  // Repeating changes nothing.
  expect(await (await call("PUT", "/chat/boost", { model: "qwen3.8-27b-ud-q4-k-m", install: false })).json()).toMatchObject({ changed: false });
  const cleared = await call("PUT", "/chat/boost", { model: "recommended" });
  expect(await cleared.json()).toMatchObject({ model: (await level("chat", "boost")).chosen, changed: true });
  expect((await (await call("PUT", "/chat/standard", { model: "recommended" })).json() as { model: string | null }).model).toBe((await level("chat", "standard")).chosen);
  expect((await level("chat", "boost")).chosen_by).toBe("recommended");
  // Off switches a level off; Standard cannot be off.
  expect(await (await call("PUT", "/chat/max", { model: "off" })).json()).toMatchObject({ model: "off" });
  expect(await level("chat", "max")).toMatchObject({ chosen: null, chosen_by: "off" });
  const standard = await call("PUT", "/chat/standard", { model: "off" });
  expect(standard.status).toBe(400);
  expect(await standard.json()).toMatchObject({ code: "standard_cannot_be_off" });
});

test("a pick is refused with a plain sentence and a stable code, and nothing is stored", async () => {
  const cases: Array<[string, string, unknown, number, string]> = [
    ["/nothing/standard", "PUT", { model: "x" }, 404, "unknown_category"],
    ["/chat/huge", "PUT", { model: "qwen3-8b-instruct-q4-k-m" }, 404, "unknown_level"],
    ["/voice/boost", "PUT", { model: "pocket-tts-english" }, 404, "no_such_level"],
    ["/chat/standard", "PUT", { model: "not-a-model" }, 404, "unknown_model"],
    ["/chat/standard", "PUT", { model: "qwen3-8b-instruct-q4-k-m", options: { warp: 9 } }, 400, "unknown_option"],
    ["/pictures/standard", "PUT", { model: "qwen3-8b-instruct-q4-k-m" }, 404, "unknown_model"],
  ];
  for (const [path, method, body, status, code] of cases) {
    const res = await call(method, path, body);
    expect(res.status, path).toBe(status);
    const json = await res.json() as { error: string; code: string };
    expect(json.code).toBe(code);
    expect(json.error.length).toBeGreaterThan(20);
  }
  // A model this computer's level cannot hold is refused with the fit decision's own sentence.
  const chat = await level("chat", "standard");
  const tooBig = chat.options.find((option) => !option.fits);
  if (tooBig) {
    const res = await call("PUT", "/chat/standard", { model: tooBig.model });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "does_not_fit", error: tooBig.refusal });
  }
  // On a 32 GB computer the Max chat model is not offered at all.
  memory = 32;
  const res = await call("PUT", "/chat/max", { model: "qwen3-8-flash-next-177b-huihui-abliterated-iq4-xs" });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: "not_offered_here" });
  expect(partInstalls).toEqual([]);
  memory = 128;
  expect((await read()).categories.every((item) => item.tiers.every((row) => row.chosen_by !== "household"))).toBe(true);
});

test("a pick for another hardware profile is stored under that profile and does not change this computer", async () => {
  const res = await call("PUT", "/chat/boost", { model: "qwen3.8-27b-ud-q4-k-m", profile: "p64", install: true });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ profile: "p64", install_job: null });
  expect(partInstalls).toEqual([]);
  const chat = await cat("chat");
  expect(chat.profiles.find((row) => row.profile === "p64")).toMatchObject({ current: false, assignments: [{ tier: "boost", model: "qwen3.8-27b-ud-q4-k-m" }] });
  expect(chat.profiles.find((row) => row.profile === "p128")!.assignments).toEqual([]);
  expect(chat.tiers.find((row) => row.tier === "boost")!.chosen_by).toBe("recommended");
  // The same pick at p16 is refused: that profile does not offer the model.
  const refused = await call("PUT", "/chat/boost", { model: "qwen3.8-27b-ud-q4-k-m", profile: "p16" });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "not_offered_here" });
  // A computer that moves to that profile reads the saved assignment.
  memory = 64;
  expect(await level("chat", "boost")).toMatchObject({ chosen: "qwen3.8-27b-ud-q4-k-m", chosen_by: "household" });
});

test("a Standard voice pick sets the voice engine the way the tiers route does, and customization is kept", async () => {
  const res = await call("PUT", "/voice/standard", { model: "voxcpm2-bf16", install: false });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ applied: true });
  expect(JSON.stringify(await (await app.request("/stack/v1/settings")).json())).toContain("voxcpm2");
  expect(settingValues()["stack.voice.engine"] ?? "").not.toBe("pocket");
  const thinking = await call("PUT", "/chat/boost", { model: "qwen3.8-27b-ud-q4-k-m", options: { thinking: true }, install: false });
  expect(thinking.status).toBe(200);
  expect((await level("chat", "boost")).customization).toEqual({ thinking: true });
});

test("the order and the off list are stored through the part choices and read back", async () => {
  const pictures = await cat("pictures");
  const first = pictures.order[0]!;
  const last = pictures.order.at(-1)!;
  const res = await call("PUT", "/pictures/order", { order: [last, first], off: [pictures.order[2]!] });
  expect(res.status).toBe(200);
  const after = await cat("pictures");
  expect(after.order.slice(0, 2)).toEqual([last, first]);
  expect(after.disabled).toEqual([pictures.order[2]!]);
  expect(after.candidates.find((candidate) => candidate.id === pictures.order[2]!)!.enabled).toBe(false);
  expect(after.candidates[0]!.rank).toBe(1);
  // It is the same value `GET /parts` reads.
  const parts = await (await app.request("/stack/v1/parts?audience=adult&category=pictures")).json() as { parts: Array<{ id: string; priority: number; enabled: boolean }> };
  expect(parts.parts.find((part) => part.id === last)!.priority).toBe(1);
  expect(parts.parts.find((part) => part.id === pictures.order[2]!)!.enabled).toBe(false);
  const bad = await call("PUT", "/pictures/order", { order: ["qwen3-8b-instruct-q4-k-m"] });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ code: "unknown_model" });
  const dup = await call("PUT", "/pictures/order", { order: [first, first] });
  expect(dup.status).toBe(400);
  expect(await dup.json()).toMatchObject({ code: "duplicate_ids" });
});

test("recommended: a dry run writes nothing; the real run stores the picks, writes the role switches and starts the Standard downloads; a repeat changes nothing", async () => {
  memory = 48;
  const dry = await (await call("POST", "/recommended", { dry_run: true })).json() as { dry_run: boolean; changed: Array<{ category: string; tier: string; to: string }>; roles: object; installs: unknown[] };
  expect(dry.dry_run).toBe(true);
  expect(dry.changed.length).toBeGreaterThan(5);
  expect(dry.roles).toEqual({});
  expect(partInstalls).toEqual([]);
  expect((await read()).categories.every((item) => item.tiers.every((row) => row.chosen_by !== "household"))).toBe(true);

  const res = await call("POST", "/recommended", {});
  expect(res.status).toBe(200);
  const done = await res.json() as { changed: Array<{ category: string; tier: string; from: string | null; to: string }>; roles: Record<string, unknown>; installs: Array<{ model: string }>; unchanged: number };
  expect(done.changed.map((row) => `${row.category}.${row.tier}`)).toEqual(dry.changed.map((row) => `${row.category}.${row.tier}`));
  expect(done.roles["stack.roles.music.enabled"]).toBeDefined();
  expect(done.installs.length + partInstalls.length).toBeGreaterThan(0);
  expect((await level("chat", "standard")).chosen_by).toBe("household");
  const again = await (await call("POST", "/recommended", {})).json() as { changed: unknown[]; unchanged: number };
  expect(again.changed).toEqual([]);
  expect(again.unchanged).toBe(done.changed.length);
  expect(isRoleDisabled("chat")).toBe(false);
});

test("recommended with household_has_minors starts the minors-only video part too; without it the part is never started (WAN-DEFAULT-01)", async () => {
  memory = 48;
  const adult = await (await call("POST", "/recommended", {})).json() as { installs: Array<{ model: string }> };
  expect([...adult.installs.map((item) => item.model), ...partInstalls]).not.toContain("fastwan2-2-ti2v-5b-mlx-bf16");
  const dry = await (await call("POST", "/recommended", { dry_run: true, household_has_minors: true })).json() as { installs: unknown[] };
  expect(dry.installs).toEqual([]);
  const home = await (await call("POST", "/recommended", { household_has_minors: true })).json() as { installs: Array<{ model: string }> };
  expect([...home.installs.map((item) => item.model), ...partInstalls]).toContain("fastwan2-2-ti2v-5b-mlx-bf16");
});

test("unused: only installed models no level or order uses are listed; removal checks each id again and keeps what became used", async () => {
  installedParts = { "qwen3-vl-4b-instruct-q4-k-m": 3e9, "qwen3-vl-8b-instruct-q4-k-m": 5e9, "qwen3-8b-instruct-q4-k-m": 5e9, "qwen3-6-35b-a3b-ud-q4-k-xl": 22e9 };
  const list = await (await call("GET", "/unused")).json() as { items: Array<{ id: string; size_bytes: number; category: string; reason: string }>; total_bytes: number; tidy: { reclaimable_bytes: number } };
  // Vision 4B is the recommended vision model and the 8B chat is chat Standard, so neither is unused; the 8B picture reader and the large chat model are.
  expect(list.items.map((item) => item.id).sort()).toEqual(["qwen3-6-35b-a3b-ud-q4-k-xl", "qwen3-vl-8b-instruct-q4-k-m"]);
  expect(list.total_bytes).toBe(27e9);
  expect(list.tidy.reclaimable_bytes).toBeGreaterThanOrEqual(0);
  expect((await read()).unused).toEqual({ count: 2, total_bytes: 27e9 });

  // Between the list and the removal the household picks the 8B picture reader.
  expect((await call("PUT", "/vision/standard", { model: "qwen3-vl-8b-instruct-q4-k-m" })).status).toBe(200);
  const res = await call("POST", "/unused/remove", { ids: ["qwen3-vl-8b-instruct-q4-k-m", "qwen3-6-35b-a3b-ud-q4-k-xl", "qwen3-vl-4b-instruct-q4-k-m", "nothing-here"] });
  expect(res.status).toBe(200);
  const out = await res.json() as { results: Array<{ id: string; status: string; message: string; freed_bytes: number }>; freed_bytes: number; kept: number };
  expect(out.results.map((row) => `${row.id}:${row.status}`)).toEqual(["qwen3-vl-8b-instruct-q4-k-m:kept", "qwen3-6-35b-a3b-ud-q4-k-xl:removed", "qwen3-vl-4b-instruct-q4-k-m:removed", "nothing-here:kept"]);
  expect(out.results[0]!.message).toContain("Vision Standard uses it");
  expect(out.freed_bytes).toBe(25e9);
  expect(removed).toEqual(["qwen3-6-35b-a3b-ud-q4-k-xl", "qwen3-vl-4b-instruct-q4-k-m"]);
});

test("a model in a category's order is not unused", async () => {
  installedParts = { "qwen3-vl-8b-instruct-q4-k-m": 5e9 };
  expect(((await (await call("GET", "/unused")).json()) as { items: unknown[] }).items).toHaveLength(1);
  expect((await call("PUT", "/vision/order", { order: ["qwen3-vl-8b-instruct-q4-k-m"] })).status).toBe(200);
  expect(((await (await call("GET", "/unused")).json()) as { items: unknown[] }).items).toHaveLength(0);
  const out = await (await call("POST", "/unused/remove", { ids: ["qwen3-vl-8b-instruct-q4-k-m"] })).json() as { results: Array<{ status: string; message: string }> };
  expect(out.results[0]).toMatchObject({ status: "kept" });
  // The order now drives the default (docs/dev/choices.md, "What runs"), so the first model in it is the one Vision Standard uses.
  expect(out.results[0]!.message).toContain("Vision Standard uses it");
  expect(removed).toEqual([]);
});

const facts = (over: Record<string, unknown> = {}) => ({
  repo: "example/tiny-chat-GGUF", revision: "rev1", file: "Tiny-Chat-Q4_K_M.gguf", url: "https://huggingface.co/example/tiny-chat-GGUF/resolve/rev1/Tiny-Chat-Q4_K_M.gguf",
  sizeBytes: 3_000_000_000, sha256: "a".repeat(64), licence: "apache-2.0", gated: false, architecture: { name: "qwen3", experts: 0, verified: true, ramBytes: 4_000_000_000, vramBytes: 4_000_000_000, shape: null }, architectureReason: null, sampling: null, samplingReason: null, ...over,
});

test("add-model stores the record, starts the checked download, selects it and lists it as an added candidate; the refusals are plain", async () => {
  inspected = facts();
  const res = await call("POST", "/add-model", { source: "https://huggingface.co/example/tiny-chat-GGUF", tier: "standard" });
  expect(res.status).toBe(200);
  const body = await res.json() as { id: string; label: string; chosen: boolean; install_job: string; state: string; licence: string };
  expect(body).toMatchObject({ chosen: true, state: "installing", licence: "apache-2.0" });
  expect(body.id).toMatch(/^added-example-tiny-chat-gguf-tiny-chat-q4-k-m-aaaaaaaa$/);
  expect(pinInstalls).toEqual([body.id]);
  const chat = await cat("chat");
  expect(chat.candidates.find((candidate) => candidate.id === body.id)).toMatchObject({ kind: "added", quantization_raw: "Q4_K_M", license: "apache-2.0", repo: "example/tiny-chat-GGUF", min_profile: null });
  expect(chat.tiers.find((row) => row.tier === "standard")).toMatchObject({ chosen: body.id, chosen_by: "household" });
  expect(chat.order).toContain(body.id);

  inspected = facts({ licence: null });
  const noLicence = await call("POST", "/add-model", { source: "example/tiny-chat-GGUF" });
  expect(noLicence.status).toBe(400);
  expect(await noLicence.json()).toMatchObject({ code: "model_facts_missing" });
  inspected = facts({ sha256: STACK_MODELS[0]!.download!.sha256 });
  const shipped = await call("POST", "/add-model", { source: "example/tiny-chat-GGUF" });
  expect(shipped.status).toBe(409);
  expect(await shipped.json()).toMatchObject({ code: "already_shipped" });
  inspected = facts({ sha256: "b".repeat(64), architecture: { name: "qwen3", experts: 0, verified: false, ramBytes: 400_000_000_000, vramBytes: 0, shape: null } });
  const big = await call("POST", "/add-model", { source: "example/tiny-chat-GGUF" });
  expect(big.status).toBe(409);
  expect(await big.json()).toMatchObject({ code: "does_not_fit" });
  inspected = null;
  const unreadable = await call("POST", "/add-model", { source: "example/tiny-chat-GGUF" });
  expect(unreadable.status).toBe(400);
  expect(await unreadable.json()).toMatchObject({ code: "cannot_read_model" });
});

test("migrate accepts or refuses each value on its own, returns the refused ones, and marks itself done", async () => {
  const body = {
    slots: [
      { role: "chat", tier: "standard", model: "qwen3-8b-instruct-q4-k-m" },
      { role: "image", tier: "boost", model: "flux2-klein-4b" },
      { role: "tts", tier: "standard", model: "pocket-tts-english" },
      { role: "chat", tier: "boost", model: "recommended" },
      { role: "chat", tier: "max", model: "off" },
      { role: "tts", tier: "boost", model: "pocket-tts-english" },
      { role: "video", tier: "standard", model: "no-such-model" },
      { role: "chat", tier: "standard", model: "added-home-record-12345678" },
    ],
    orders: [{ category: "pictures", order: ["ernie-image-turbo", "flux2-klein-4b"] }, { category: "videos", order: ["nope"] }],
    features: [{ role: "music", enabled: false }, { role: "chat", enabled: true }, { role: "toaster", enabled: true }],
    added_models: [{ id: "added-home-record-12345678", label: "Home record", repo: "example/home-record", file: "r.gguf", url: "https://huggingface.co/example/home-record/resolve/r/r.gguf", revision: "r", sha256: "c".repeat(64), size_bytes: 1_000_000_000, licence: "mit", architecture: "qwen3", verified: true, ram_bytes: 2_000_000_000 }],
  };
  const dry = await (await call("POST", "/migrate", { ...body, dry_run: true })).json() as { dry_run: boolean; done_at: string | null };
  expect(dry).toMatchObject({ dry_run: true, done_at: null });
  expect((await read()).migration.done).toBe(false);
  expect((await cat("chat")).candidates.some((candidate) => candidate.kind === "added")).toBe(false);
  expect(isRoleDisabled("music")).toBe(false);

  const res = await call("POST", "/migrate", body);
  expect(res.status).toBe(200);
  const out = await res.json() as { already_done: boolean; results: Array<{ kind: string; key: string; status: string; reason: string | null }>; accepted: number; refused: Array<{ key: string; reason: string }>; done_at: string };
  const status = (kind: string, key: string) => out.results.find((row) => row.kind === kind && row.key === key)!.status;
  expect(status("added_model", "added-home-record-12345678")).toBe("accepted");
  expect(status("slot", "chat.standard")).toBe("accepted");
  expect(status("slot", "image.boost")).toBe("accepted");
  expect(status("slot", "tts.standard")).toBe("accepted");
  expect(status("slot", "chat.max")).toBe("accepted");
  expect(status("order", "pictures")).toBe("accepted");
  expect(status("feature", "music")).toBe("accepted");
  expect(status("feature", "chat")).toBe("unchanged");
  expect(out.refused.map((row) => row.key).sort()).toEqual(["tts.boost", "toaster", "video.standard", "videos"].sort());
  expect(out.refused.every((row) => row.reason.length > 15)).toBe(true);
  // The last chat.standard value names the added record and wins, being later in the list.
  expect((await level("chat", "standard")).chosen).toBe("added-home-record-12345678");
  expect((await level("pictures", "boost")).chosen).toBe("flux2-klein-4b");
  expect((await level("chat", "max")).chosen_by).toBe("off");
  expect((await cat("pictures")).order.slice(0, 2)).toEqual(["ernie-image-turbo", "flux2-klein-4b"]);
  expect(isRoleDisabled("music")).toBe(true);
  const view = await read();
  expect(view.migration).toMatchObject({ done: true, accepted: out.accepted, refused: 4 });

  // Once done, a second call reads and writes nothing.
  const second = await (await call("POST", "/migrate", { ...body, slots: [{ role: "chat", tier: "standard", model: "qwen3-8b-instruct-q4-k-m" }] })).json() as { already_done: boolean; results: unknown[] };
  expect(second).toMatchObject({ already_done: true, results: [] });
  expect((await level("chat", "standard")).chosen).toBe("added-home-record-12345678");
});

test("Coding has a Max level that is the Max chat model: it reads what Chat Max reads and cannot be set on its own", async () => {
  const view = await read();
  const coding = view.categories.find((item) => item.id === "coding")!;
  expect(coding.tiers.map((row) => row.tier)).toEqual(["standard", "max"]);
  const chatMax = await level("chat", "max");
  const codingMax = await level("coding", "max");
  expect(codingMax.chosen).toBe(chatMax.chosen);
  expect(codingMax.options.map((option) => option.model)).toEqual(chatMax.options.map((option) => option.model));
  // Switching Chat Max off switches Coding Max off with it: one choice, not two.
  await call("PUT", "/chat/max", { model: "off" });
  expect(await level("coding", "max")).toMatchObject({ chosen: null, chosen_by: "off" });
  // Changing Coding Max changes Chat Max: one choice with two doors.
  const FLASH = "qwen3-8-flash-next-177b-huihui-abliterated-iq4-xs";
  const picked = await call("PUT", "/coding/max", { model: FLASH, install: false });
  expect(picked.status).toBe(200);
  expect((await level("chat", "max")).chosen).toBe(FLASH);
  expect((await level("coding", "max")).chosen).toBe(FLASH);
  // The Coding card lists the big model, so its Max row can show a size and a state.
  const after = (await read()).categories.find((item) => item.id === "coding")!;
  expect(after.candidates.map((candidate) => candidate.id)).toContain(FLASH);
  expect(after.tiers.find((row) => row.tier === "max")!.chosen_state).not.toBeNull();
});
