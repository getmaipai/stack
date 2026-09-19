import { afterEach, expect, test } from "bun:test";
import { __setHuggingFaceFetchForTests, hfUrl, huggingFaceEndpoint, resolveHuggingFace, searchHuggingFace } from "@/lib/hf";
import { __resetStackSettingsForTests, updateStackConfig } from "@/settings/stackKeys";

afterEach(() => { __resetStackSettingsForTests(); __setHuggingFaceFetchForTests(null); });

test("hfUrl builds URLs from the default Hugging Face endpoint", () => {
  expect(huggingFaceEndpoint()).toBe("https://huggingface.co");
  expect(hfUrl("Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf")).toBe("https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf");
  expect(hfUrl("api/models?search=gguf")).toBe("https://huggingface.co/api/models?search=gguf");
});

test("hfUrl follows the Hugging Face endpoint setting, with a trailing slash allowed", () => {
  updateStackConfig({ huggingFaceEndpoint: "https://hf.internal/" });
  expect(huggingFaceEndpoint()).toBe("https://hf.internal");
  expect(hfUrl("/Qwen/Qwen3-8B-GGUF/resolve/7c41481f/chat.gguf")).toBe("https://hf.internal/Qwen/Qwen3-8B-GGUF/resolve/7c41481f/chat.gguf");
});

function response(body: unknown): Response { return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }); }
function model(repo: string, options: { task?: string; gated?: false | "manual"; cardData?: unknown; config?: unknown } = {}) {
  return { _id: `id-${repo}`, id: repo, private: false, pipeline_tag: options.task, downloads: 1, gated: options.gated ?? false, likes: 1, lastModified: "2026-09-18T00:00:00.000Z", sha: "a".repeat(40), cardData: options.cardData ?? { license: "Apache-2.0" }, config: options.config ?? {}, tags: [] };
}

test("scripted Hugging Face metadata resolves chat GGUF, image, gated, and unsupported repositories honestly", async () => {
  updateStackConfig({ huggingFaceSearchEnabled: true });
  const models = new Map([
    ["chat/repo", model("chat/repo", { task: "text-generation" })],
    ["image/repo", model("image/repo", { task: "text-to-image" })],
    ["gated/repo", model("gated/repo", { task: "text-generation", gated: "manual" })],
    ["other/repo", model("other/repo")],
  ]);
  __setHuggingFaceFetchForTests(async (input) => {
    const url = String(input);
    if (url.includes("/tree/")) return response([{ type: "file", path: "model.gguf", size: 12, lfs: { size: 12, oid: "b".repeat(64) } }]);
    const repo = [...models.keys()].find((name) => url.includes(`/models/${name}`));
    if (repo) return response(models.get(repo));
    if (url.includes("/api/models?")) return response([...models.values()]);
    return new Response("not found", { status: 404 });
  });
  expect(await searchHuggingFace("repo")).toHaveLength(4);
  await expect(resolveHuggingFace("chat/repo")).resolves.toMatchObject({ revision: "a".repeat(40), role: "chat", files: [{ name: "model.gguf", sizeBytes: 12, sha256: "b".repeat(64) }] });
  await expect(resolveHuggingFace("image/repo")).resolves.toMatchObject({ role: "image" });
  await expect(resolveHuggingFace("gated/repo")).resolves.toMatchObject({ gated: true, role: "chat" });
  await expect(resolveHuggingFace("other/repo")).resolves.toMatchObject({ role: "unknown" });
});

test("Hugging Face search sends no request while its own switch is off", async () => {
  let calls = 0;
  __setHuggingFaceFetchForTests(async () => { calls++; return response([]); });
  expect(await searchHuggingFace("never sent")).toEqual([]);
  expect(calls).toBe(0);
});
