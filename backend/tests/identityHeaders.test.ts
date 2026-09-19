import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDataDir = process.env.STACK_DATA_DIR;
const testDataDir = mkdtempSync(join(tmpdir(), "maipai-stack-identity-headers-"));
process.env.STACK_DATA_DIR = testDataDir;
const { app } = await import("@/app");
const { testClientHeaders } = await import("./authTest");
const { registerCatalogModel } = await import("@/lib/modelStore");

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.STACK_DATA_DIR;
  else process.env.STACK_DATA_DIR = originalDataDir;
  rmSync(testDataDir, { recursive: true, force: true });
});

const bodies: Record<string, Record<string, unknown>> = {
  "/v1/chat/completions": { model: "chat", messages: [] },
  "/v1/embeddings": { model: "chat", input: "hello" },
  "/v1/audio/transcriptions": { model: "chat", file: "audio" },
  "/v1/audio/speech": { model: "chat", input: "hello" },
  "/v1/images/generations": { model: "chat", prompt: "a local picture" },
};

test("every OpenAI route carries identity headers when no engine answers", async () => {
  const document = await (await app.request("/api/openapi.json")).json() as { paths: Record<string, { post?: unknown }> };
  for (const path of Object.entries(document.paths).filter(([candidate, methods]) => candidate.startsWith("/v1/") && methods.post).map(([path]) => path)) {
    const response = await app.request(path, {
      method: "POST",
      headers: { ...testClientHeaders, "content-type": "application/json" },
      body: JSON.stringify(bodies[path]),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("x-maipai-engine")).toBe("none");
    expect(response.headers.get("x-maipai-model")).toBe("none");
    expect(response.headers.get("x-maipai-revision")).toBe("none");
  }
  const unauthenticated = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodies["/v1/chat/completions"]),
  });
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.headers.get("x-maipai-engine")).toBe("none");
  expect(unauthenticated.headers.get("x-maipai-model")).toBe("none");
  expect(unauthenticated.headers.get("x-maipai-revision")).toBe("none");
});

test("an unverified model is a 409 with its missing provenance", async () => {
  registerCatalogModel({ id: "unverified-review-model", role: "chat", license: "Apache-2.0", revision: "rev" });
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...testClientHeaders, "content-type": "application/json" },
    body: JSON.stringify({ model: "unverified-review-model", messages: [] }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ model: "unverified-review-model", reason: "unverified" });
  expect(response.headers.get("x-maipai-engine")).toBe("none");
});

test("streaming chat carries identity headers when no engine answers", async () => {
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...testClientHeaders, "content-type": "application/json" },
    body: JSON.stringify({ model: "chat", messages: [], stream: true }),
  });
  const plain = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...testClientHeaders, "content-type": "application/json" },
    body: JSON.stringify({ model: "chat", messages: [] }),
  });
  expect(response.status).toBe(503);
  const streamingReason = (await response.json() as { offline_reason: string }).offline_reason;
  expect(typeof streamingReason).toBe("string");
  expect(streamingReason.length).toBeGreaterThan(0);
  expect(streamingReason).toBe((await plain.json() as { offline_reason: string }).offline_reason);
  expect(response.headers.get("x-maipai-engine")).toBe("none");
  expect(response.headers.get("x-maipai-model")).toBe("none");
  expect(response.headers.get("x-maipai-revision")).toBe("none");
});
