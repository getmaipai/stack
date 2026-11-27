// STACK-RERANK-FILL-01: the rerank role answers on /v1/rerank, scores in order, on llama-server's own --reranking.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { ROLES } from "@/roles";
import { setMachineTier, resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { __resetHealthForTests } from "@/lib/health";
import { clearModelsForTests } from "@/lib/modelStore";
import { STACK_MODELS, STACK_RERANK_MODEL } from "@/lib/modelCatalog";
import { llamaServerArgs } from "@/lib/engineArgs";

beforeEach(() => { setMachineTier(null); __resetHealthForTests(); clearModelsForTests(); setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); });
afterEach(() => { setMachineTier(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); });

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a query with ten passages returns every passage scored, best first, with its original index", async () => {
  const documents = Array.from({ length: 10 }, (_, i) => `passage ${i}`);
  const response = await app.request("/v1/rerank", json({ model: "rerank", query: "which passage is best", documents }));
  expect(response.status).toBe(200);
  const body = await response.json() as { results: Array<{ index: number; relevance_score: number }> };
  expect(body.results).toHaveLength(10);
  const scores = body.results.map((r) => r.relevance_score);
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
  expect(new Set(body.results.map((r) => r.index)).size).toBe(10);
  expect(response.headers.get("x-maipai-engine")).toBeTruthy();
});

test("top_n keeps the best few, and a role on the wrong endpoint is a 400", async () => {
  const documents = ["a", "b", "c", "d"];
  const top = await app.request("/v1/rerank", json({ model: "rerank", query: "q", documents, top_n: 2 }));
  expect((await top.json() as { results: unknown[] }).results).toHaveLength(2);
  const wrong = await app.request("/v1/rerank", json({ model: "chat", query: "q", documents }));
  expect(wrong.status).toBe(400);
  const empty = await app.request("/v1/rerank", json({ model: "rerank", query: "q", documents: [] }));
  expect(empty.status).toBe(400);
});

test("the rerank role is declared, spawnable and pinned to an Apache-2.0 bge-reranker GGUF run with --reranking", () => {
  expect(ROLES.rerank.endpoints).toEqual(["/v1/rerank"]);
  expect((ROLES.rerank as { spawnable?: boolean }).spawnable).toBe(true);
  expect(STACK_MODELS).toContain(STACK_RERANK_MODEL);
  expect(STACK_RERANK_MODEL).toMatchObject({ role: "rerank", license: "Apache-2.0", engine: "llama-server" });
  expect(STACK_RERANK_MODEL.download?.sha256).toMatch(/^[0-9a-f]{64}$/);
  const args = llamaServerArgs({ modelPath: "/m.gguf", port: 1, config: {} as never, contextLength: 8192, kvCacheType: "f16", gpuLayers: 99, reranking: true } as never);
  expect(args).toContain("--reranking");
  expect(args).not.toContain("--embeddings");
});
