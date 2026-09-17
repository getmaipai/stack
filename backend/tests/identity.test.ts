import { describe, expect, test } from "bun:test";
import { hostLabel, identityHeaders, sanitizeEngineUrl, readEngineIdentity, formatEngineIdentity, modelFileName } from "@/lib/identity";

describe("identity", () => {
  test("headers use the engine host, model file, and build revision", () => {
    expect(identityHeaders({ host: "local", model: "chat.gguf", build: "b10797", healthy: true })).toEqual({
      "x-maipai-engine": "local",
      "x-maipai-model": "chat.gguf",
      "x-maipai-revision": "b10797",
    });
    expect(identityHeaders(null)).toEqual({ "x-maipai-engine": "none", "x-maipai-model": "none", "x-maipai-revision": "none" });
  });

  test("a loopback URL is local and other hosts are external", () => {
    expect(hostLabel("http://127.0.0.1:8788")).toBe("local");
    expect(hostLabel("http://localhost:8788")).toBe("local");
    expect(hostLabel("http://[::1]:8788")).toBe("local");
    expect(hostLabel("http://192.0.2.10:8788")).toBe("external");
    expect(sanitizeEngineUrl("http://127.0.0.1:8788")).toBe("http://127.0.0.1:8788");
    expect(sanitizeEngineUrl("http://192.0.2.10:8788")).toBe("external");
    expect(sanitizeEngineUrl("not a url")).toBe("external");
    expect(sanitizeEngineUrl(undefined)).toBe("n/a");
  });

  test("reads identity from health and props, and handles a dead engine", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/health") return Response.json({ status: "ok" });
        if (path === "/props") return Response.json({ build_info: "b10797-832fd6f17", model_path: "/srv/models/chat.gguf" });
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const identity = await readEngineIdentity(`http://127.0.0.1:${server.port}`);
      expect(identity).toEqual({ host: "local", build: "b10797-832fd6f17", model: "chat.gguf", healthy: true });
      expect(formatEngineIdentity(identity)).toBe("local b10797-832fd6f17 chat.gguf");
    } finally {
      server.stop(true);
    }
    const dead = await readEngineIdentity("http://127.0.0.1:1", 500);
    expect(dead).toEqual({ host: "local", build: null, model: null, healthy: false });
    expect(formatEngineIdentity(dead)).toBe("local");
    expect(modelFileName("C:\\models\\chat.gguf")).toBe("chat.gguf");
  });
});
