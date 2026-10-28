import { afterEach, expect, test } from "bun:test";
import { __setHuggingFaceFetchForTests } from "@/lib/hf";
import { InspectRefusal, inspectModel, parseSource } from "@/lib/modelInspect";

afterEach(() => __setHuggingFaceFetchForTests(null));

const SHA = "a".repeat(40);
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function script(options: { gated?: false | "manual"; card?: Response; files?: unknown[] } = {}) {
  __setHuggingFaceFetchForTests(async (input) => {
    const url = String(input);
    if (url.includes("/tree/")) return json(options.files ?? [{ type: "file", path: "m-Q4_K_M.gguf", size: 12, lfs: { size: 12, oid: "b".repeat(64) } }]);
    if (url.endsWith("generation_config.json")) return options.card ?? json({ temperature: 0.6, top_p: 0.95, top_k: 20, do_sample: true });
    if (url.includes("/api/models/owner/repo")) return json({ _id: "1", id: "owner/repo", private: false, pipeline_tag: "text-generation", downloads: 1, gated: options.gated ?? false, likes: 1, lastModified: "2026-09-18T00:00:00.000Z", sha: SHA, cardData: { license: "apache-2.0" }, tags: [] });
    return new Response("not found", { status: 404 });
  });
}

test("parseSource takes a huggingface.co link or owner/repo and refuses every other host", () => {
  expect(parseSource("https://huggingface.co/owner/repo/blob/main/m-Q4_K_M.gguf")).toEqual({ repo: "owner/repo", revision: "main", file: "m-Q4_K_M.gguf" });
  expect(parseSource("owner/repo", "x.gguf")).toEqual({ repo: "owner/repo", file: "x.gguf" });
  expect(() => parseSource("https://evil.example.com/owner/repo")).toThrow(InspectRefusal);
  expect(() => parseSource("http://huggingface.co/owner/repo")).toThrow(InspectRefusal);
  expect(() => parseSource("https://huggingface.co.evil.example/owner/repo")).toThrow(InspectRefusal);
  expect(() => parseSource("not a model")).toThrow(InspectRefusal);
});

test("inspect returns the published size, hash, licence and the card's sampling without downloading weights", async () => {
  script();
  const result = await inspectModel({ source: "owner/repo" });
  expect(result).toMatchObject({ repo: "owner/repo", revision: SHA, file: "m-Q4_K_M.gguf", sizeBytes: 12, sha256: "b".repeat(64), licence: "apache-2.0", sampling: { temperature: 0.6, top_p: 0.95, top_k: 20 }, samplingReason: null });
});

test("a missing sampling card is null with a reason, never a guess", async () => {
  script({ card: new Response("nope", { status: 404 }) });
  const result = await inspectModel({ source: "owner/repo" });
  expect(result.sampling).toBeNull();
  expect(result.samplingReason).toContain("no generation_config.json");
});

test("a gated repository, a missing file and an ambiguous repository are refused with what to do", async () => {
  script({ gated: "manual" });
  await expect(inspectModel({ source: "owner/repo" })).rejects.toThrow(/gated/);
  script();
  await expect(inspectModel({ source: "owner/repo", file: "other.gguf" })).rejects.toThrow(/not in owner\/repo/);
  script({ files: [{ type: "file", path: "a.gguf", size: 1 }, { type: "file", path: "b.gguf", size: 1 }] });
  await expect(inspectModel({ source: "owner/repo" })).rejects.toThrow(/2 model files/);
  script({ files: [{ type: "file", path: "w.safetensors", size: 1 }] });
  await expect(inspectModel({ source: "owner/repo", file: "w.safetensors" })).rejects.toThrow(/GGUF/);
});
