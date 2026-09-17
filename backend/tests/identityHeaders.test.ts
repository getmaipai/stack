import { expect, test } from "bun:test";
import { app } from "@/app";
import { testClientHeaders } from "./authTest";

const bodies: Record<string, Record<string, unknown>> = {
  "/v1/chat/completions": { model: "chat", messages: [] },
  "/v1/embeddings": { model: "chat", input: "hello" },
  "/v1/audio/transcriptions": { model: "chat", file: "audio" },
  "/v1/audio/speech": { model: "chat", input: "hello" },
  "/v1/images/generations": { model: "chat", prompt: "a local picture" },
};

test("every OpenAI route carries identity headers when no engine answers", async () => {
  const document = await (await app.request("/api/openapi.json")).json() as { paths: Record<string, { post?: unknown }> };
  for (const path of Object.keys(document.paths).filter((candidate) => candidate.startsWith("/v1/"))) {
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
