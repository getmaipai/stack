import { expect, test } from "bun:test";
import { app } from "@/app";
import { resolveRole, UnknownRoleError } from "@/lib/router";

test("a role name resolves without a binding", () => {
  const result = resolveRole("chat");
  expect(result.role).toBe("chat");
  expect(result.binding).toBeNull();
  expect(["notInstalled", "installed", "loading", "ready", "busy", "stopped", "offline"]).toContain(result.state);
});

test("an unknown role or model is rejected with the declared roles", async () => {
  expect(() => resolveRole("made-up-model")).toThrow(UnknownRoleError);
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "made-up-model", messages: [] }),
  });
  expect(response.status).toBe(400);
  expect(response.headers.get("x-maipai-engine")).toBe("none");
  expect((await response.json() as { roles: string[] }).roles).toContain("chat");
});

test("an unbound role is a 503 with a reason and empty identity headers", async () => {
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chat", messages: [] }),
  });
  expect(response.status).toBe(503);
  expect((await response.json() as { offline_reason: string }).offline_reason).toBeTruthy();
  expect(response.headers.get("x-maipai-engine")).toBe("none");
  expect(response.headers.get("x-maipai-model")).toBe("none");
  expect(response.headers.get("x-maipai-revision")).toBe("none");
});
