// ISOLATION-04b: the engines the Stack starts take requests only from the Stack. The speech worker's real server (Bun), the shared
// Python guard the speech server and Pocket TTS launcher use, and the wiring that gives every worker its key.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startSpeechServer } from "@/speech/server";
import { checkEngineCaller, ENGINE_KEY_ENV } from "@/lib/loopbackGuard";
import { OpenAIEngineClient } from "@/lib/supervisor";

const KEY = `launch-${crypto.randomUUID()}`;
const transcriber = { transcribe: async () => "hello" } as never;
const server = startSpeechServer({ port: 0, key: KEY, build: "test", modelPath: "/m", transcriber, detector: () => ({ push: () => false, reset() {} }) as never });
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));
const code = async (res: Response) => ((await res.json()) as { code?: string }).code;
const ok = { authorization: `Bearer ${KEY}` };

test("a forged Host is refused on every route, health included (DNS rebinding)", async () => {
  for (const path of ["/health", "/props"]) {
    const res = await fetch(base + path, { headers: { host: "rebind.example.com", ...ok } });
    expect(res.status).toBe(421);
    expect(await code(res)).toBe("host_not_allowed");
  }
});

test("a request from a web page (Origin) is refused even with the key", async () => {
  const res = await fetch(base + "/props", { headers: { origin: "https://evil.example.com", ...ok } });
  expect(res.status).toBe(403);
  expect(await code(res)).toBe("origin_not_allowed");
});

test("without the key or with a wrong one the engine says what to do and runs nothing", async () => {
  for (const headers of [{} as Record<string, string>, { authorization: "Bearer " + "x".repeat(8) }, { authorization: KEY }, { authorization: "Bearer " + KEY + "x" }]) {
    const res = await fetch(base + "/props", { headers });
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("engine_key_required");
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  }
  const post = await fetch(base + "/v1/audio/transcriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ audio_base64: "AAAA" }) });
  expect(post.status).toBe(401);
});

test("the websocket session cannot be opened without the key", async () => {
  const res = await fetch(base + "/v1/audio/session", { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": btoa("0123456789abcdef") } });
  expect(res.status).toBe(401);
});

test("the Stack's own client gets through: health is open to a loopback caller, the rest carries the key", async () => {
  expect((await fetch(base + "/health")).status).toBe(200);
  const client = new OpenAIEngineClient(base, "/health", KEY);
  expect(await client.health()).toBe(true);
  expect((await client.raw("/props", { method: "GET" })).status).toBe(200);
  expect(client.authHeaders()).toEqual(ok);
  expect(new OpenAIEngineClient(base).authHeaders()).toEqual({});
});

test("a worker started by hand (no key) still refuses a forged Host and a web page", () => {
  const request = (headers: Record<string, string>) => new Request("http://127.0.0.1:1/props", { headers });
  expect(checkEngineCaller(request({ host: "evil.example.com" }), undefined)?.status).toBe(421);
  expect(checkEngineCaller(request({ host: "127.0.0.1:1", origin: "https://evil.example.com" }), undefined)?.status).toBe(403);
  expect(checkEngineCaller(request({ host: "127.0.0.1:1" }), undefined)).toBeNull();
});

// ---- the shared Python guard (speech server, Pocket TTS launcher) --------------------------------------------------

const guardPath = join(import.meta.dir, "../src/speech/engine_guard.py");
function pyRefusal(args: { method?: string; path?: string; host?: string | null; origin?: string | null; authorization?: string | null; key?: string }): [number, string] | null {
  const program = "import json,sys; sys.path.insert(0, sys.argv[1]); import engine_guard as g; a=json.loads(sys.argv[2]); r=g.refusal(a['method'],a['path'],a['host'],a['origin'],a['authorization'],a['key']); print(json.dumps(r and [r[0], r[1]]))";
  const payload = { method: "GET", path: "/props", host: "127.0.0.1:9", origin: null, authorization: null, key: KEY, ...args };
  const out = Bun.spawnSync(["python3", "-I", "-c", program, join(guardPath, ".."), JSON.stringify(payload)]);
  expect(out.exitCode).toBe(0);
  return JSON.parse(out.stdout.toString());
}

test("engine_guard.py: forged Host 421, Origin 403, no or wrong key 401, the right key and /health pass", () => {
  expect(pyRefusal({ host: "rebind.example.com" })).toEqual([421, "host_not_allowed"]);
  expect(pyRefusal({ host: null })).toEqual([421, "host_not_allowed"]);
  expect(pyRefusal({ host: "127.0.0.1.evil.com" })).toEqual([421, "host_not_allowed"]);
  expect(pyRefusal({ origin: "https://evil.example.com", authorization: `Bearer ${KEY}` })).toEqual([403, "origin_not_allowed"]);
  expect(pyRefusal({ origin: "null", authorization: `Bearer ${KEY}` })).toEqual([403, "origin_not_allowed"]);
  expect(pyRefusal({})).toEqual([401, "engine_key_required"]);
  expect(pyRefusal({ authorization: "Bearer wrong" })).toEqual([401, "engine_key_required"]);
  expect(pyRefusal({ method: "POST", path: "/tts" })).toEqual([401, "engine_key_required"]);
  expect(pyRefusal({ method: "POST", path: "/health" })).toEqual([401, "engine_key_required"]);
  expect(pyRefusal({ authorization: `Bearer ${KEY}` })).toBeNull();
  expect(pyRefusal({ host: "localhost:8123", authorization: `Bearer ${KEY}`, method: "POST", path: "/tts" })).toBeNull();
  expect(pyRefusal({ host: "[::1]:8123", authorization: `Bearer ${KEY}` })).toBeNull();
  expect(pyRefusal({ method: "GET", path: "/health" })).toBeNull();
  expect(pyRefusal({ key: "" })).toBeNull();
});

test("every Python engine of the Stack runs the guard before any route", () => {
  const dir = join(import.meta.dir, "../src/speech");
  const mlx = readFileSync(join(dir, "mlx_tts_server.py"), "utf8");
  expect(mlx).toContain("import engine_guard");
  expect(mlx.match(/if self\.refused\("(GET|POST)"\):/g)?.length).toBe(2);
  const pocket = readFileSync(join(dir, "pocket_tts_server.py"), "utf8");
  expect(pocket).toContain("add_middleware(EngineGuard)");
  expect(pocket).toContain("engine_guard.refusal(");
});

test("every worker the Stack starts is given a launch key, and the worker reads the one the spawn sets", () => {
  const supervisor = readFileSync(join(import.meta.dir, "../src/lib/supervisor.ts"), "utf8");
  expect(supervisor).toContain("[ENGINE_KEY_ENV]: plan.apiKey");
  expect(supervisor).toContain("SPLASH_API_KEY: plan.apiKey");
  for (const engine of ["sherpa-onnx-node", "chatterbox-turbo", "pocket-tts"]) {
    const line = supervisor.split("\n").find((l) => l.includes(`engine: "${engine}"`) && l.includes("command:"));
    expect(line, engine).toContain("apiKey: newLaunchKey()");
  }
  expect(readFileSync(join(import.meta.dir, "../src/speech/worker.ts"), "utf8")).toContain("key: process.env[ENGINE_KEY_ENV]");
  expect(ENGINE_KEY_ENV).toBe("STACK_ENGINE_KEY");
});
