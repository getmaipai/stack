// STACK-LORAS-01 slices 1 and 2: the unified LoRA catalog, its fence, trash, import, drives, install and move.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { addDisk, removeDisk, listDisks } from "@/lib/disks";
import { db } from "@/db";
import { disks } from "@/db/schema";
import { dataDir } from "@/lib/paths";
import { getJob, __resetJobsForTests } from "@/lib/jobs";
import { recordGlobalLicenceAcceptance } from "@/lib/licenceAcceptance";
import { __resetLoraStoreForTests, legacyLoraDir, loraStorePath, mergeLegacyManifests, readAllLoras, writeAllLoras } from "@/lib/media/loraStore";
import { getCatalog, importCatalog, listCatalog, patchCatalog, purgeCatalog, restoreCatalog, sweepLoraTrash, trashCatalog } from "@/lib/media/loraCatalog";
import { __resetSourceLimitForTests, browseSource, setSourceKey, sourceKey, sourceStatus, startCatalogInstall, startLoraMove, __resetLoraMoveForTests } from "@/lib/media/loraSources";
import { imageLoras, __resetImageLoraInstallForTests } from "@/images/loras";
import { getLora as getVideoLora, resolveLoras as resolveVideoLoras } from "@/video/loras";
import type { LoraRecord } from "@/lib/media/loraLibrary";

function safetensors(seed = "a") {
  const header = { __metadata__: { base_model: "z-image-turbo" }, "diffusion_model.layers.0.attention.to_k.lora_A.weight": { dtype: "BF16", shape: [16, 3840], data_offsets: [0, 8] }, "diffusion_model.layers.0.attention.to_k.lora_B.weight": { dtype: "BF16", shape: [3840, 16], data_offsets: [8, 16] } };
  const json = Buffer.from(JSON.stringify(header)); const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(json.length));
  const payload = Buffer.alloc(16); payload.write(seed.padEnd(16, "."));
  return Buffer.concat([length, json, payload]);
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const scratch = (): string => mkdtempSync(join(tmpdir(), "stack-lora-test-"));
const drives: string[] = [];

/** Adds a real picture LoRA file through the library, the way an install does. */
async function addPicture(seed: string, extra: { classification?: "all-ages" | "adult-only"; diskId?: string | null } = {}) {
  const dir = scratch(); drives.push(dir); const path = join(dir, `${seed}.safetensors`); writeFileSync(path, safetensors(seed));
  return imageLoras.importFile({ path, name: `Style ${seed}`, licence: "mit", classification: extra.classification ?? "all-ages", diskId: extra.diskId ?? null });
}

beforeEach(() => {
  __resetJobsForTests(); __resetImageLoraInstallForTests(); __resetLoraStoreForTests(); __resetSourceLimitForTests(); __resetLoraMoveForTests();
  for (const path of [loraStorePath(), join(dataDir, "licence-acceptances.json"), join(dataDir, "lora-source-keys.json"), join(legacyLoraDir("picture"), "manifest.json"), join(legacyLoraDir("video"), "manifest.json")]) rmSync(path, { force: true });
  rmSync(legacyLoraDir("picture"), { recursive: true, force: true }); rmSync(legacyLoraDir("video"), { recursive: true, force: true }); rmSync(join(dataDir, "loras"), { recursive: true, force: true });
  db.delete(disks).run();
});
afterEach(() => { for (const dir of drives.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const legacy = (media: "picture" | "video", id: string, extra: Partial<LoraRecord> = {}): LoraRecord => ({ id, name: id, file: `${id}.safetensors`, sha256: id.slice(5).padEnd(64, "0"), bytes: 100, mtime_ms: 1, rank: 8, modules: 2, base_model: media === "picture" ? "z-image-turbo" : "ltx-2.5", licence: "mit", licence_class: "free", source_url: null, classification: "all-ages", classification_note: null, strength_default: 1, trigger_words: [], added_by: null, added_at: "2026-11-01T00:00:00.000Z", ...extra });
const writeLegacy = (media: "picture" | "video", records: LoraRecord[]) => { mkdirSync(legacyLoraDir(media), { recursive: true }); writeFileSync(join(legacyLoraDir(media), "manifest.json"), JSON.stringify({ loras: records })); };

test("merge: the two old manifests become one store, idempotently, and the old files are left alone", () => {
  writeLegacy("picture", [legacy("picture", "lora-aaaaaaaaaaaaaaaa")]); writeLegacy("video", [legacy("video", "lora-bbbbbbbbbbbbbbbb", { classification: "adult-only" })]);
  const before = readFileSync(join(legacyLoraDir("picture"), "manifest.json"), "utf8");
  expect(mergeLegacyManifests()).toBe(2);
  expect(mergeLegacyManifests()).toBe(0);
  const all = readAllLoras();
  expect(all.map((r) => [r.id, r.media, r.disk_id])).toEqual([["lora-aaaaaaaaaaaaaaaa", "picture", null], ["lora-bbbbbbbbbbbbbbbb", "video", null]]);
  expect(readFileSync(join(legacyLoraDir("picture"), "manifest.json"), "utf8")).toBe(before);
  expect(imageLoras.list().map((r) => r.id)).toEqual(["lora-aaaaaaaaaaaaaaaa"]);
  expect(getVideoLora("lora-bbbbbbbbbbbbbbbb")?.classification).toBe("adult-only");
});

test("merge: a record the store already has is never overwritten by an old manifest, and an edit survives a re-merge", () => {
  writeLegacy("picture", [legacy("picture", "lora-aaaaaaaaaaaaaaaa", { name: "old name" })]);
  mergeLegacyManifests();
  writeAllLoras(readAllLoras().map((r) => ({ ...r, name: "edited" })));
  expect(mergeLegacyManifests()).toBe(0);
  expect(readAllLoras()[0]!.name).toBe("edited");
});

test("fence: an unknown or trashed id counts as adult-only for a non-adult audience; an adult-only file needs an adult audience", async () => {
  const adult = await addPicture("dark", { classification: "adult-only" }); const safe = await addPicture("safe");
  expect((await imageLoras.resolve([{ id: safe.id }], "all-ages", "z-image-turbo"))[0]!.record.id).toBe(safe.id);
  await expect(imageLoras.resolve([{ id: "lora-0123456789abcdef" }], "all-ages", "z-image-turbo")).rejects.toThrow(/No LoRA/);
  trashCatalog(safe.id);
  await expect(imageLoras.resolve([{ id: adult.id }], "all-ages", "z-image-turbo")).rejects.toThrow(/adult-only/);
  await expect(imageLoras.resolve([{ id: "lora-0123456789abcdef" }], "adult", "z-image-turbo")).rejects.toThrow(/No LoRA/);
  await expect(imageLoras.resolve([{ id: safe.id }], "adult", "z-image-turbo")).rejects.toThrow(/No LoRA/);
  expect((await imageLoras.resolve([{ id: adult.id }], "adult", "z-image-turbo"))[0]!.record.id).toBe(adult.id);
});

test("fence on the video path: resolveLoras refuses an unknown id and an adult-only file for an all-ages clip", async () => {
  writeLegacy("video", [legacy("video", "lora-bbbbbbbbbbbbbbbb", { classification: "adult-only" })]);
  await expect(resolveVideoLoras([{ id: "lora-bbbbbbbbbbbbbbbb" }], "all-ages", "ltx-2.5")).rejects.toThrow(/adult-only/);
  await expect(resolveVideoLoras([{ id: "lora-ccccccccccccccc0" }], "all-ages", "ltx-2.5")).rejects.toThrow(/No LoRA/);
});

test("an admin sets or lowers the nsfw tag directly, no ticket; the origin becomes admin", async () => {
  const adult = await addPicture("dark", { classification: "adult-only" });
  expect(getCatalog(adult.id)!.classification_origin).toBeNull();
  const lowered = await patchCatalog(adult.id, { classification: "all-ages" });
  expect(lowered.classification).toBe("all-ages");
  expect(lowered.classification_origin).toBe("admin");
  const safe = await addPicture("safe");
  expect((await patchCatalog(safe.id, { classification: "adult-only", name: "Renamed", description: "A soft look" })).classification).toBe("adult-only");
  expect(getCatalog(safe.id)!.name).toBe("Renamed");
  expect((getCatalog(safe.id)!.home as { description: string }).description).toBe("A soft look");
});

test("PATCH route: lowering the tag needs no ticket and the body no longer takes one", async () => {
  const adult = await addPicture("dark", { classification: "adult-only" });
  const response = await app.request(`/stack/v1/loras/${adult.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ classification: "all-ages" }) });
  expect(response.status).toBe(200);
  const body = await response.json() as { classification: string; classification_origin: string };
  expect(body.classification).toBe("all-ages");
  expect(body.classification_origin).toBe("admin");
  expect(getCatalog(adult.id)!.classification).toBe("all-ages");
});

test("trash: unusable at once, listed under removed, restorable, swept after 30 days", async () => {
  const record = await addPicture("safe");
  trashCatalog(record.id, new Date("2026-11-01T00:00:00Z"));
  expect(listCatalog().map((r) => r.id)).toEqual([]); expect(listCatalog({ removed: true }).map((r) => r.id)).toEqual([record.id]);
  expect(getCatalog(record.id)!.trash_until).toBe("2026-12-01T00:00:00.000Z");
  restoreCatalog(record.id); expect(listCatalog().map((r) => r.id)).toEqual([record.id]);
  trashCatalog(record.id, new Date("2026-11-01T00:00:00Z"));
  expect(sweepLoraTrash(new Date("2026-11-30T00:00:00Z"))).toBe(0);
  expect(sweepLoraTrash(new Date("2026-12-02T00:00:00Z"))).toBe(1);
  expect(readAllLoras()).toEqual([]); expect(existsSync(join(legacyLoraDir("picture"), `${record.id}.safetensors`))).toBe(false);
  expect(purgeCatalog(record.id)).toBe(false);
});

test("import: idempotent by id, never creates, never lowers, reports a fingerprint conflict", () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dir, "..", "node_modules", "@maipai", "spec", "fixtures", "records", "lora.suggesting-off.example.json"), "utf8"));
  const id = fixture.id as string;
  expect(importCatalog([{ lora: fixture }])[0]!.result).toBe("missing_file");
  expect(readAllLoras()).toEqual([]);
  writeAllLoras([legacy("video", id, { sha256: fixture.file.sha256, classification: "adult-only" })]);
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const first = importCatalog([{ lora: fixture, preview: { content_type: "image/png", data_base64: png } }])[0]!;
  expect(first.result).toBe("imported"); expect(first.note).toMatch(/never lowers/);
  const stored = getCatalog(id)!;
  expect(stored.classification).toBe("adult-only"); expect(stored.name).toBe(fixture.name); expect(stored.preview).toBe(`${id}.png`);
  expect((stored.home as { description: string }).description).toBe(fixture.description);
  expect(importCatalog([{ lora: fixture, preview: { content_type: "image/png", data_base64: png } }])[0]!.result).toBe("unchanged");
  expect(importCatalog([{ lora: { ...fixture, file: { ...fixture.file, sha256: "f".repeat(64) } } }])[0]!.result).toBe("conflict");
  expect(importCatalog([{ lora: { id: "nope" } }])[0]!.result).toBe("invalid");
  expect(readAllLoras()).toHaveLength(1);
});

test("a drive that is not connected shows drive_missing and the style is refused with a plain line", async () => {
  const root = scratch(); drives.push(root);
  const disk = addDisk({ label: "Backup", rootPath: root, removable: true });
  const dir = scratch(); drives.push(dir); const path = join(dir, "x.safetensors"); writeFileSync(path, safetensors("x"));
  const record = await imageLoras.importFile({ path, name: "On drive", licence: "mit", classification: "all-ages", diskId: disk.id });
  expect(existsSync(join(root, "loras", `${record.id}.safetensors`))).toBe(true);
  expect(getCatalog(record.id)).toMatchObject({ disk_id: disk.id, status: "ready", disk_label: "Backup" });
  expect((await imageLoras.resolve([{ id: record.id }], "all-ages", "z-image-turbo"))[0]!.path).toBe(join(root, "loras", `${record.id}.safetensors`));
  rmSync(root, { recursive: true, force: true });
  expect(getCatalog(record.id)).toMatchObject({ status: "drive_missing" });
  expect(getCatalog(record.id)!.status_note).toMatch(/not connected/);
  await expect(imageLoras.resolve([{ id: record.id }], "all-ages", "z-image-turbo")).rejects.toMatchObject({ code: "drive_missing" });
  const res = await app.request("/stack/v1/loras"); const body = await res.json() as { loras: Array<{ id: string; status: string }> };
  expect(body.loras.find((l) => l.id === record.id)!.status).toBe("drive_missing");
});

test("install: refused without the global licence accept, then installs onto a second drive using the saved key", async () => {
  const root = scratch(); drives.push(root); const disk = addDisk({ label: "Fast", rootPath: root, removable: false });
  const file = safetensors("dl"); const seen: Array<Record<string, string>> = [];
  const fetch = (async (url: string, init?: RequestInit) => { if (url.includes("/api/models/")) return new Response(JSON.stringify({ tags: ["lora"] }), { status: 200 }); seen.push(Object.fromEntries(new Headers(init?.headers).entries())); return new Response(file, { status: 200, headers: { "content-length": String(file.length) } }); }) as unknown as typeof globalThis.fetch;
  const input = { media: "picture" as const, site: "huggingface" as const, url: "https://huggingface.co/owner/name/resolve/main/style.safetensors", name: "From HF", diskId: disk.id, licence: "mit", classification: "all-ages" as const };
  expect(() => startCatalogInstall(input, { fetch })).toThrow(/Accept the licences in the Stack admin/);
  recordGlobalLicenceAcceptance("test");
  setSourceKey("huggingface", "hf_secret_token_value");
  const job = startCatalogInstall(input, { fetch });
  for (let i = 0; i < 300 && getJob(job.id)!.state === "running"; i++) await Bun.sleep(10);
  expect(getJob(job.id)!.state).toBe("done");
  expect(seen[0]!.authorization).toBe("Bearer hf_secret_token_value");
  const id = `lora-${sha(file).slice(0, 16)}`;
  expect(getCatalog(id)).toMatchObject({ media: "picture", disk_id: disk.id, status: "ready", classification: "all-ages", classification_origin: "site" });
  expect(existsSync(join(root, "loras", `${id}.safetensors`))).toBe(true);
  expect(() => startCatalogInstall({ ...input, diskId: "ghost" }, { fetch })).toThrow(/not connected/);
});

/** Installs one Civitai file; `check` answers the version lookup (the site's adult check). */
async function installFromCivitai(seed: string, check: () => Response | Promise<Response>, classification?: "all-ages" | "adult-only") {
  recordGlobalLicenceAcceptance("test");
  const file = safetensors(seed);
  const fetch = (async (url: string) => { if (url.includes("/api/v1/model-versions/")) return check(); return new Response(file, { status: 200, headers: { "content-length": String(file.length) } }); }) as unknown as typeof globalThis.fetch;
  const job = startCatalogInstall({ media: "picture", site: "civitai", url: "https://civitai.com/api/download/models/777", name: `Civ ${seed}`, licence: "mit", ...(classification ? { classification } : {}) }, { fetch });
  for (let i = 0; i < 300 && getJob(job.id)!.state === "running"; i++) await Bun.sleep(10);
  expect(getJob(job.id)!.state).toBe("done");
  return getCatalog(`lora-${sha(file).slice(0, 16)}`)!;
}

test("install: the site says nsfw -> tagged nsfw, origin site, even when the caller asked all-ages", async () => {
  const record = await installFromCivitai("n1", () => new Response(JSON.stringify({ nsfwLevel: 4, model: { nsfw: true } }), { status: 200 }), "all-ages");
  expect(record).toMatchObject({ classification: "adult-only", classification_origin: "site" });
});

test("install: the site says not nsfw -> tagged all-ages, origin site; a caller can still raise it", async () => {
  const clean = () => new Response(JSON.stringify({ nsfwLevel: 1, model: { nsfw: false } }), { status: 200 });
  expect(await installFromCivitai("c1", clean)).toMatchObject({ classification: "all-ages", classification_origin: "site" });
  expect(await installFromCivitai("c2", clean, "adult-only")).toMatchObject({ classification: "adult-only", classification_origin: "site" });
});

test("install: the check is unavailable, errors, or leaves the flag out -> tagged nsfw", async () => {
  expect((await installFromCivitai("u1", () => { throw new Error("offline"); }, "all-ages")).classification).toBe("adult-only");
  expect((await installFromCivitai("u2", () => new Response("no", { status: 503 }), "all-ages")).classification).toBe("adult-only");
  expect((await installFromCivitai("u3", () => new Response(JSON.stringify({ model: {} }), { status: 200 }), "all-ages")).classification).toBe("adult-only");
});

test("install: an admin can lower a site-tagged nsfw style afterwards", async () => {
  const record = await installFromCivitai("l1", () => new Response("no", { status: 500 }));
  expect(record).toMatchObject({ classification: "adult-only", classification_origin: "site" });
  expect(await patchCatalog(record.id, { classification: "all-ages" })).toMatchObject({ classification: "all-ages", classification_origin: "admin" });
});

test("move: copies to another drive, checks the fingerprint, switches the record, removes the original; a failed check keeps the original", async () => {
  const a = scratch(), b = scratch(); drives.push(a, b);
  const disk = addDisk({ label: "Second", rootPath: a, removable: true });
  const record = await addPicture("mv");
  const original = join(legacyLoraDir("picture"), `${record.id}.safetensors`); expect(existsSync(original)).toBe(true);
  const job = await startLoraMove(record.id, disk.id);
  for (let i = 0; i < 300 && getJob(job.id)!.state === "running"; i++) await Bun.sleep(10);
  expect(getJob(job.id)!.state).toBe("done");
  expect(getCatalog(record.id)!.disk_id).toBe(disk.id);
  expect(existsSync(original)).toBe(false); expect(existsSync(join(a, "loras", `${record.id}.safetensors`))).toBe(true);
  await expect(startLoraMove(record.id, disk.id)).rejects.toMatchObject({ code: "same_drive" });
  // back to the main disk, but the copy is corrupted after it is made
  __resetLoraMoveForTests();
  const back = await startLoraMove(record.id, "main", { afterCopy: () => { writeFileSync(join(imageLoras.dir(), `${record.id}.safetensors.moving`), "corrupt"); } });
  for (let i = 0; i < 300 && getJob(back.id)!.state === "running"; i++) await Bun.sleep(10);
  expect(getJob(back.id)!.state).toBe("failed");
  expect(getCatalog(record.id)!.disk_id).toBe(disk.id); expect(existsSync(join(a, "loras", `${record.id}.safetensors`))).toBe(true);
  expect(existsSync(join(imageLoras.dir(), `${record.id}.safetensors.moving`))).toBe(false);
  rmSync(a, { recursive: true, force: true });
  await expect(startLoraMove(record.id, "main")).rejects.toMatchObject({ code: "drive_missing" });
});

test("a drive with a style on it cannot be removed", async () => {
  const root = scratch(); drives.push(root); const disk = addDisk({ label: "Holds", rootPath: root, removable: true });
  const record = await addPicture("held", { diskId: disk.id });
  expect(() => removeDisk(disk.id)).toThrow(/1 style is on Holds/);
  purgeCatalog(record.id); removeDisk(disk.id); expect((await listDisks()).some((d) => d.id === disk.id)).toBe(false);
});

test("sources: browse Hugging Face and Civitai with a fake source, classify from the site's own fields, rate-limit, never return the key", async () => {
  const requests: string[] = [];
  const fetch = (async (url: string) => {
    requests.push(url);
    if (url.includes("huggingface.co/api/models")) return Response.json([{ id: "owner/cute-style", downloads: 5, tags: ["lora"], siblings: [{ rfilename: "a.safetensors" }], cardData: { license: "mit", base_model: "z-image-turbo" } }, { id: "owner/nsfw-thing", tags: ["nsfw"], siblings: [{ rfilename: "n.safetensors" }] }, { id: "owner/no-file", siblings: [] }]);
    return Response.json({ items: [{ id: 7, name: "Clay", nsfw: false, modelVersions: [{ baseModel: "LTXV", files: [{ name: "c.safetensors", sizeKB: 2, downloadUrl: "https://civitai.com/api/download/models/99" }] }] }, { id: 8, name: "Spicy", nsfw: true, modelVersions: [{ files: [{ name: "s.safetensors", downloadUrl: "https://civitai.com/api/download/models/100" }] }] }] });
  }) as unknown as typeof globalThis.fetch;
  const hf = await browseSource("huggingface", "style", { fetch, now: 1_000_000 });
  expect(hf.map((h) => [h.remote_id, h.audience_hint])).toEqual([["owner/cute-style", "all-ages"], ["owner/nsfw-thing", "adult-only"]]);
  expect(hf[0]!.install_url).toBe("https://huggingface.co/owner/cute-style/resolve/main/a.safetensors");
  await expect(browseSource("civitai", "clay", { fetch, now: 1_000_500 })).rejects.toMatchObject({ code: "source_busy" });
  const civ = await browseSource("civitai", "clay", { fetch, now: 1_003_000 });
  expect(civ.map((h) => [h.install_url, h.audience_hint])).toEqual([["https://civitai.com/api/download/models/99", "all-ages"], ["https://civitai.com/api/download/models/100", "adult-only"]]);
  expect(() => setSourceKey("civitai", "short")).toThrow(/key or token/);
  setSourceKey("civitai", "civitai_key_value_123");
  expect(sourceKey("civitai")).toBe("civitai_key_value_123");
  expect(JSON.stringify(sourceStatus())).not.toContain("civitai_key_value_123");
  expect(readFileSync(join(dataDir, "lora-source-keys.json"), "utf8")).not.toContain("civitai_key_value_123");
  const routeResponse = await app.request("/stack/v1/loras/sources"); expect(JSON.stringify(await routeResponse.json())).not.toContain("civitai_key_value_123");
  setSourceKey("civitai", null); expect(sourceKey("civitai")).toBeNull();
});

test("POST /stack/v1/loras/install reaches the LoRA install, not the components route, and is refused until the licence is accepted", async () => {
  const body = JSON.stringify({ media: "picture", source: "civitai", url: "https://civitai.com/api/download/models/12345", name: "x" });
  const refused = await app.request("/stack/v1/loras/install", { method: "POST", headers: { "content-type": "application/json" }, body });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { code: string }).code).toBe("licence_not_accepted");
});
