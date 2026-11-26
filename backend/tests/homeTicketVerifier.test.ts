// The adult-lock ticket check against Home, and the lowering that uses it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomeTicketVerifier, installHomeTicketVerifierFromEnv } from "@/lib/media/homeTicketVerifier";
import { getCatalog, patchCatalog, setAdultTicketVerifier } from "@/lib/media/loraCatalog";
import { __resetLoraStoreForTests, loraStorePath } from "@/lib/media/loraStore";
import { imageLoras } from "@/images/loras";

const TEST_TOKEN = ["fake", "view", "value", "for", "tests"].join("-");
const reply = (status: number, body: unknown) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
const make = (fetchFn: typeof fetch, timeoutMs?: number) => createHomeTicketVerifier({ baseUrl: "http://127.0.0.1:8787/", token: TEST_TOKEN, fetchFn, timeoutMs });

beforeEach(() => { __resetLoraStoreForTests(); rmSync(loraStorePath(), { force: true }); setAdultTicketVerifier(null); });
afterEach(() => setAdultTicketVerifier(null));

test("verifier sends the ticket, item and token, and accepts only 200 { ok: true }", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const spy = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ ok: true }), { status: 200 }); }) as unknown as typeof fetch;
  expect(await make(spy)("t-1", "lora-1")).toBe(true);
  expect(seen!.url).toBe("http://127.0.0.1:8787/api/stack/adult-ticket/consume");
  expect(JSON.parse(String(seen!.init.body))).toEqual({ ticket: "t-1", item: "lora-1" });
  expect((seen!.init.headers as Record<string, string>)["x-maipai-home-token"]).toBe(TEST_TOKEN);
});

test("verifier fails closed on false, non-200, garbage, error and timeout", async () => {
  expect(await make(reply(200, { ok: false }))("t", "l")).toBe(false);
  expect(await make(reply(403, { ok: true }))("t", "l")).toBe(false);
  expect(await make(reply(200, "not json"))("t", "l")).toBe(false);
  expect(await make(reply(200, { ok: "true" }))("t", "l")).toBe(false);
  expect(await make((async () => { throw new Error("down"); }) as unknown as typeof fetch)("t", "l")).toBe(false);
  const hang = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
  expect(await make(hang, 30)("t", "l")).toBe(false);
});

test("env install: unset, bad scheme and non-loopback install nothing; loopback installs", async () => {
  for (const value of [undefined, "", "not a url", "ftp://127.0.0.1/", "http://192.0.2.5:8787", "http://100.64.0.1:8787", "http://home.example.com", "http://127.0.0.1.example.com"]) {
    expect(installHomeTicketVerifierFromEnv({ STACK_HOME_CALLBACK_URL: value } as NodeJS.ProcessEnv)).toBe(false);
  }
  // Nothing installed: a lowering is still refused.
  const adult = await imageLoras.importFile({ path: mkLora(), name: "Dark", licence: "mit", classification: "adult-only", diskId: null });
  await expect(patchCatalog(adult.id, { classification: "all-ages", ticket: "t" })).rejects.toMatchObject({ code: "ticket_refused" });
  for (const value of ["http://127.0.0.1:8787", "http://localhost:8787", "https://localhost", "http://[::1]:8787"]) {
    expect(installHomeTicketVerifierFromEnv({ STACK_HOME_CALLBACK_URL: value, STACK_HOME_VIEW_TOKEN: TEST_TOKEN } as NodeJS.ProcessEnv)).toBe(true);
  }
});

function mkLora(): string {
  const header = { __metadata__: { base_model: "z-image-turbo" }, "diffusion_model.layers.0.attention.to_k.lora_A.weight": { dtype: "BF16", shape: [16, 3840], data_offsets: [0, 8] }, "diffusion_model.layers.0.attention.to_k.lora_B.weight": { dtype: "BF16", shape: [3840, 16], data_offsets: [8, 16] } };
  const json = Buffer.from(JSON.stringify(header)); const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(json.length));
  const path = join(mkdtempSync(join(tmpdir(), "stack-ticket-test-")), `${Math.random().toString(36).slice(2)}.safetensors`);
  writeFileSync(path, Buffer.concat([length, json, Buffer.alloc(16, 7)])); return path;
}

test("a lowering passes the lora id and only the right ticket for it is accepted", async () => {
  const adult = await imageLoras.importFile({ path: mkLora(), name: "Dark", licence: "mit", classification: "adult-only", diskId: null });
  const calls: Array<[string, string]> = [];
  setAdultTicketVerifier(async (ticket, loraId) => { calls.push([ticket, loraId]); return ticket === "t-good" && loraId === adult.id; });
  await expect(patchCatalog(adult.id, { classification: "all-ages", ticket: "t-bad" })).rejects.toMatchObject({ code: "ticket_refused" });
  expect((await patchCatalog(adult.id, { classification: "all-ages", ticket: "t-good" })).classification).toBe("all-ages");
  expect(calls).toEqual([["t-bad", adult.id], ["t-good", adult.id]]);
});

test("availability_who writes home.availability.who and keeps people", async () => {
  const item = await imageLoras.importFile({ path: mkLora(), name: "Soft", licence: "mit", classification: "all-ages", diskId: null });
  await patchCatalog(item.id, { availabilityWho: "adults" });
  expect((getCatalog(item.id)!.home as { availability: unknown }).availability).toEqual({ who: "adults", people: [] });
  const { readAllLoras, writeAllLoras } = await import("@/lib/media/loraStore");
  const all = readAllLoras(); const i = all.findIndex((r) => r.id === item.id);
  all[i] = { ...all[i]!, home: { ...(all[i]!.home ?? {}), availability: { who: "people", people: ["p1"] } } }; writeAllLoras(all);
  await patchCatalog(item.id, { availabilityWho: "admins", description: "x" });
  const home = getCatalog(item.id)!.home as { availability: unknown; description: string };
  expect(home.availability).toEqual({ who: "admins", people: ["p1"] });
  expect(home.description).toBe("x");
});

test("home_patch keeps Home-only fields in the record's home part and refuses anything else", async () => {
  const item = await imageLoras.importFile({ path: mkLora(), name: "Ink", licence: "mit", classification: "all-ages", diskId: null });
  await patchCatalog(item.id, { homePatch: { allow_suggesting: false, trigger_position: "end", positive_addins: ["soft light"], strength: { min: 0.2, default: 0.8, max: 1.4 } } });
  expect(getCatalog(item.id)!.home).toMatchObject({ allow_suggesting: false, trigger_position: "end", positive_addins: ["soft light"], strength: { min: 0.2, default: 0.8, max: 1.4 } });
  await expect(patchCatalog(item.id, { homePatch: { classification: "adult-only" } })).rejects.toMatchObject({ code: "bad_home_patch", status: 422 });
  await expect(patchCatalog(item.id, { homePatch: { strength: { min: 1, default: 0.5, max: 2 } } })).rejects.toMatchObject({ code: "bad_home_patch" });
  await expect(patchCatalog(item.id, { homePatch: { positive_addins: "x" } })).rejects.toMatchObject({ code: "bad_home_patch" });
});
