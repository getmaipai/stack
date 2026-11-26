// STACK-LORAS-01 slice 3: GET /stack/v1/loras/{id}/preview serves the preview file from data/loras/previews, and nothing else.
import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { dataDir } from "@/lib/paths";
import { __resetJobsForTests } from "@/lib/jobs";
import { __resetLoraStoreForTests, legacyLoraDir, loraStorePath } from "@/lib/media/loraStore";
import { listCatalog, previewDir } from "@/lib/media/loraCatalog";
import type { LoraRecord } from "@/lib/media/loraLibrary";

const record = (id: string, extra: Partial<LoraRecord> = {}): LoraRecord => ({ id, name: id, file: `${id}.safetensors`, sha256: id.slice(5).padEnd(64, "0"), bytes: 100, mtime_ms: 1, rank: 8, modules: 2, base_model: "z-image-turbo", licence: "mit", licence_class: "free", source_url: null, classification: "all-ages", classification_note: null, strength_default: 1, trigger_words: [], added_by: null, added_at: "2026-11-01T00:00:00.000Z", ...extra });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

beforeEach(() => {
  __resetJobsForTests(); __resetLoraStoreForTests();
  for (const path of [loraStorePath(), join(legacyLoraDir("picture"), "manifest.json"), join(legacyLoraDir("video"), "manifest.json")]) rmSync(path, { force: true });
  rmSync(join(dataDir, "loras"), { recursive: true, force: true });
});

test("the preview of a style is served with its picture type, and a style without one is a 404", async () => {
  mkdirSync(legacyLoraDir("picture"), { recursive: true }); mkdirSync(previewDir(), { recursive: true });
  const withPreview = "lora-aaaaaaaaaaaaaaaa", without = "lora-bbbbbbbbbbbbbbbb";
  writeFileSync(join(legacyLoraDir("picture"), "manifest.json"), JSON.stringify({ loras: [record(withPreview, { preview: `${withPreview}.png` } as Partial<LoraRecord>), record(without)] }));
  writeFileSync(join(previewDir(), `${withPreview}.png`), PNG);
  expect(listCatalog({}).length).toBe(2);
  const ok = await app.request(`/stack/v1/loras/${withPreview}/preview`);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true);
  const none = await app.request(`/stack/v1/loras/${without}/preview`);
  expect(none.status).toBe(404);
  expect(await none.json()).toMatchObject({ code: "no_preview" });
  expect((await app.request("/stack/v1/loras/lora-cccccccccccccccc/preview")).status).toBe(404);
});

test("a preview name that points outside the previews folder, or a file that is gone, is a 404", async () => {
  mkdirSync(legacyLoraDir("picture"), { recursive: true }); mkdirSync(previewDir(), { recursive: true });
  const escape = "lora-dddddddddddddddd", gone = "lora-eeeeeeeeeeeeeeee";
  writeFileSync(join(dataDir, "secret.png"), PNG);
  writeFileSync(join(legacyLoraDir("picture"), "manifest.json"), JSON.stringify({ loras: [record(escape, { preview: "../../secret.png" } as Partial<LoraRecord>), record(gone, { preview: `${gone}.png` } as Partial<LoraRecord>)] }));
  listCatalog({});
  expect((await app.request(`/stack/v1/loras/${escape}/preview`)).status).toBe(404);
  expect((await app.request(`/stack/v1/loras/${gone}/preview`)).status).toBe(404);
  rmSync(join(dataDir, "secret.png"), { force: true });
});
