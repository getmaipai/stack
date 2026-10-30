// MEM-SPACE-03/04/06: the reclaim list and run, and the capabilities rows, through the app and the pure functions.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus } from "@/lib/governor";
import { listReclaimable, runReclaim, type ReclaimDeps } from "@/lib/reclaim";
import { setMachineTier } from "@/lib/supervisor";

const GB = 1_000_000_000;
beforeEach(() => { __resetGovernorForTests(); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 100 * GB, tier: "p128" }); });
afterEach(() => { setMachineTier(null); __resetGovernorForTests(); });

const load = async (id: string, kind: "jit" | "resident" | "generator", cls: "reserved" | "warm" | "burst", bytes: number, extra: Record<string, unknown> = {}): Promise<void> => {
  await admit({ id, kind, class: cls, requestedBytes: bytes, ...extra } as Parameters<typeof admit>[0]);
};
const deps = (over: Partial<ReclaimDeps> & { unloaded?: string[] } = {}): ReclaimDeps => ({ busy: () => false, unload: async (id) => { over.unloaded?.push(id); return true; }, now: () => Date.now() + 3 * 60_000, ...over });

test("reclaim lists idle burst and warm items in eviction order, never chat, a busy item or a running generator", async () => {
  await load("chat", "resident", "reserved", 20 * GB);
  await load("image-pool", "jit", "warm", 18 * GB);
  await load("music-worker", "jit", "burst", 16 * GB);
  await load("busy-one", "jit", "warm", 5 * GB);
  await load("running-job", "generator", "burst", 10 * GB);
  await load("service-owned", "resident", "warm", 4 * GB);
  const list = await listReclaimable(deps({ busy: (id) => id === "busy-one" }));
  expect(list.items.map((item) => item.id)).toEqual(["music-worker", "image-pool"]);
  expect(list.total_bytes).toBe(34 * GB);
  expect(list.items[0]).toEqual({ id: "music-worker", kind: "burst", bytes: 16 * GB });
});

test("an item an unload cannot stop is never listed, and a leaving item is skipped", async () => {
  await load("service-owned", "resident", "warm", 4 * GB);
  expect((await listReclaimable(deps())).items).toEqual([]);
  await load("music-worker", "jit", "burst", 16 * GB);
  const { beginEvicting } = await import("@/lib/governor");
  beginEvicting("music-worker");
  expect((await listReclaimable(deps())).items).toEqual([]);
});

test("a warm item inside its 2 minute grace is not listed and its bytes are reported apart", async () => {
  await load("image-pool", "jit", "warm", 18 * GB);
  const early = await listReclaimable({ ...deps(), now: () => Date.now() + 119_000 });
  expect(early).toMatchObject({ items: [], total_bytes: 0, held_for_grace_bytes: 18 * GB });
  const late = await listReclaimable({ ...deps(), now: () => Date.now() + 121_000 });
  expect(late.items.map((item) => item.id)).toEqual(["image-pool"]);
  expect(late.held_for_grace_bytes).toBe(0);
});

test("running reclaim unloads the listed items, frees them from the ledger, counts only real unloads and skips an item that became busy", async () => {
  await load("chat", "resident", "reserved", 20 * GB);
  await load("music-worker", "jit", "burst", 16 * GB);
  await load("declines", "jit", "burst", 3 * GB);
  await load("image-pool", "jit", "warm", 18 * GB);
  const unloaded: string[] = [];
  const result = await runReclaim(deps({ unloaded, unload: async (id) => { unloaded.push(id); return id !== "declines"; } }));
  expect(result).toEqual({ unloaded: 2, freed_bytes: 34 * GB });
  expect(unloaded).not.toContain("chat");
  expect(getGovernorStatus().loaded.map((item) => item.id).sort()).toEqual(["chat", "declines"]);
});

test("a second reclaim while one is running unloads nothing", async () => {
  await load("music-worker", "jit", "burst", 16 * GB);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = runReclaim(deps({ unload: async () => { await gate; return true; } }));
  await Bun.sleep(5);
  expect(await runReclaim(deps())).toEqual({ unloaded: 0, freed_bytes: 0 });
  release();
  expect(await first).toEqual({ unloaded: 1, freed_bytes: 16 * GB });
});

test("the reclaim routes answer with ids and byte counts only", async () => {
  const get = await app.request("/stack/v1/memory/reclaim");
  expect(get.status).toBe(200);
  expect(await get.json()).toEqual({ items: [], total_bytes: 0, held_for_grace_bytes: 0 });
  const post = await app.request("/stack/v1/memory/reclaim", { method: "POST" });
  expect(post.status).toBe(200);
  expect(await post.json()).toEqual({ unloaded: 0, freed_bytes: 0 });
  const memory = await (await app.request("/stack/v1/memory")).json() as { dev_load: { others_bytes: number; processes: unknown[] } };
  expect(memory.dev_load).toMatchObject({ processes: expect.any(Array) });
});

test("capabilities gives one row per category and level from the catalog and the governor's fits_ever", async () => {
  setMachineTier("p128");
  const res = await app.request("/stack/v1/capabilities");
  expect(res.status).toBe(200);
  const body = await res.json() as { machine_class: string; total_bytes: number; rows: Array<{ category: string; tier: string; fits_ever: boolean; needs_bytes: number | null; cap_bytes: number; model: string | null }> };
  expect(body.machine_class).toBe("p128");
  expect(body.total_bytes).toBe(128 * GB);
  expect(body.rows).toHaveLength(15);
  const row = (category: string, tier: string) => body.rows.find((item) => item.category === category && item.tier === tier)!;
  expect(row("image", "max")).toMatchObject({ model: "qwen-image-2512-q8", needs_bytes: 37_400_000_000 });
  expect(row("video", "max")).toMatchObject({ model: null, needs_bytes: null, fits_ever: false });
  expect(row("music", "max")).toMatchObject({ model: null, fits_ever: false });
  expect(row("voice", "standard")).toMatchObject({ model: "chatterbox-turbo-fp16" });
  for (const item of body.rows) { expect(item.cap_bytes).toBeGreaterThan(0); if (item.model) expect(item.fits_ever).toBe(true); }
});

test("capabilities on a computer too small for any profile reports unknown and nothing fits", async () => {
  const body = await (await app.request("/stack/v1/capabilities")).json() as { machine_class: string; rows: Array<{ fits_ever: boolean; model: string | null }> };
  expect(body.machine_class).toBe("unknown");
  expect(body.rows.every((item) => !item.fits_ever && item.model === null)).toBe(true);
});
