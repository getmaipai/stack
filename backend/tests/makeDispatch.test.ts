import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { fillRecipe, parseRecipe } from "@/lib/recipe";
import { pictureBody, dispatchPicture } from "@/lib/makeDispatch";
import { planMake } from "@/lib/makePlan";
import { PART_DEFS } from "@/lib/partDefs";
import { __setPartsHardwareForTests } from "@/lib/partsList";
import { __resetPartChoicesForTests } from "@/lib/partChoices";
import { jobsCatalog } from "@/lib/jobsCatalog";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import type { StackMakeRequest } from "@maipai/spec/stack/ts/stack-make.js";
import type { HardwareInfo } from "@/lib/hardware";

const GB = 1_073_741_824;
const hw: HardwareInfo = { platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 1500 * GB, osVersion: "test" };
beforeEach(() => { __resetPartChoicesForTests(); __setPartsHardwareForTests(hw); });
afterEach(() => { __resetPartChoicesForTests(); __setPartsHardwareForTests(null); });

const ready = (id: string): StackPartView => { const d = PART_DEFS.find((p) => p.id === id)!; return { id, kind: d.kind, category: d.category, priority: d.priority, label: d.label, description: "", enabled: true, state: "ready", size_bytes: 1, download_bytes: 1, percent: null, fits: { standard: true, boost: true, max: true, reason: null }, can_install: false, install_block: null, can_uninstall: true, uninstall_block: null, licence_needed: false, required_by: [], update: { available: false, version: null } } as StackPartView; };
const request = (over: Partial<Extract<StackMakeRequest, { job: "picture" }>> = {}): Extract<StackMakeRequest, { job: "picture" }> => ({ job: "picture", audience: "adult", description: "a red barn", shape: "square", level: "standard", seed: 7, count: 2, ...over });
const planned = (req = request()) => { const p = planMake(req, [ready("flux3-image-klein"), ready("minimax-h3-image")]); if (!p.ok) throw new Error("not planned"); return p; };

test("a recipe splits into base, words addendum and a note that is never sent", () => {
  const r = parseRecipe("{description}\n---words---\nSpell: \"{words}\"\n---measured---\nnote");
  expect(r).toEqual({ base: "{description}", wordsAddendum: "Spell: \"{words}\"", measured: "note" });
  expect(fillRecipe("{description}\n---words---\nSpell: \"{words}\"\n---measured---\nnote", { description: "a barn" })).toBe("a barn");
  expect(fillRecipe("{description}\n---words---\nSpell: \"{words}\"\n---measured---\nnote", { description: "a barn", words: "OPEN" })).toBe("a barn\n\nSpell: \"OPEN\"");
});
test("the old route's body comes from the pack: part id, pixel size, seed, count, audience, the recipe's prompt", () => {
  const body = pictureBody(request(), planned());
  expect(body).toMatchObject({ model: "flux3-image-klein", size: "1024x1024", n: 2, seed: 7, audience: "adult", prompt: "a red barn" });
});
test("exact words add the pack's spelling addendum and nothing else changes", () => {
  const body = pictureBody(request({ words: "OPEN" }), planned(request({ words: "OPEN" })));
  expect(String(body.prompt)).toContain('"OPEN"');
  expect(String(body.prompt)).toContain("Spell every word exactly as written");
  expect(body.size).toBe("1024x1024");
});
test("a minor's request goes to the old route as all-ages", () => {
  const req = request({ audience: "minor" });
  const plan = planMake(req, [ready("flux3-image-klein")].map((p) => p));
  expect(plan.ok).toBe(true);
  expect(pictureBody(req, plan as never).audience).toBe("all-ages");
});
test("the result carries the job id, the files and what it was made with", async () => {
  const sent: unknown[] = [];
  const result = await dispatchPicture(request(), planned(), async (path, body) => { sent.push([path, body]); return { status: 200, json: { job: "j1", data: [{ url: "/v1/images/generations/j1/0.png" }], notes: ["Steps are fixed at 16."] } }; });
  expect((sent[0] as [string])[0]).toBe("/v1/images/generations");
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ id: "j1", job: "picture", state: "done", percent: 100, files: ["/v1/images/generations/j1/0.png"], made_with: { part: "flux3-image-klein", pack_version: "1.0.0", sound: false, notes: ["Steps are fixed at 16."] } });
});
test("a refusal from the old route passes through unchanged", async () => {
  const result = await dispatchPicture(request(), planned(), async () => ({ status: 503, json: { error: "not installed", code: "not_installed" } }));
  expect(result).toEqual({ status: 503, body: { error: "not installed", code: "not_installed" } });
});

test("the route answers not_available when nothing that can do it is ready", async () => {
  const response = await app.request("/stack/v1/jobs/make", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request()) });
  expect(response.status).toBe(409);
  expect((await response.json() as { code: string }).code).toBe("not_available");
});
test("the route answers not_on_this_model for a named part that cannot do the job", async () => {
  const response = await app.request("/stack/v1/jobs/make", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request({ part: "ltx-2-5-q8-distilled-mlx" })) });
  expect(response.status).toBe(409);
  expect((await response.json() as { code: string }).code).toBe("not_on_this_model");
});
test("the catalog never calls an unwired job available", async () => {
  const catalog = await jobsCatalog("adult");
  for (const job of catalog.jobs) if (job.job !== "picture") expect(job.available).toBe(false);
});
