import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { MACHINE_PREFIX, SANDBOX_NETWORK, SandboxError, SandboxService, clamp, machineName, setSandboxServiceForTests, type ContainerRunner, type ContainerStreamer, type ExecChunk, type SandboxConfig } from "@/lib/sandbox";

let streamed: string[][]; let streamAborted: boolean;
const fakeStream: ContainerStreamer = async function* (args, signal) {
  streamed.push(args);
  signal.addEventListener("abort", () => { streamAborted = true; });
  yield { stream: "stdout", text: "hi\n" } as ExecChunk;
  yield { stream: "stderr", text: "oops\n" } as ExecChunk;
  if (args.includes("hang")) await new Promise((resolve) => signal.addEventListener("abort", resolve));
  yield { exit: signal.aborted ? 137 : 0 } as ExecChunk;
};
let root: string; let work: string; let calls: string[][]; let machines: Map<string, string>; let lockOk: boolean; let now: number; let networks: string[];

const fake: ContainerRunner = async (args) => {
  calls.push(args);
  const [a, b] = args;
  if (a === "network" && b === "list") return { code: 0, stdout: JSON.stringify(networks.map((id) => ({ id }))), stderr: "" };
  if (a === "network" && b === "create") { networks.push(args.at(-1)!); return { code: 0, stdout: "", stderr: "" }; }
  if (a === "run") { machines.set(args[args.indexOf("--name") + 1]!, lockOk ? "running" : "stopped"); return { code: 0, stdout: "id", stderr: "" }; }
  if (a === "list") return { code: 0, stdout: JSON.stringify([...machines].map(([id, status]) => ({ status, configuration: { id } }))), stderr: "" };
  if (a === "exec") return { code: lockOk ? 0 : 1, stdout: "", stderr: "" };
  if (a === "logs") return { code: 0, stdout: lockOk ? "" : "sandbox-entry: the network lock rules did not load", stderr: "" };
  if (a === "stop") { const id = args.at(-1)!; if (machines.has(id)) machines.set(id, "stopped"); return { code: 0, stdout: "", stderr: "" }; }
  if (a === "delete") { machines.delete(args.at(-1)!); return { code: 0, stdout: "", stderr: "" }; }
  return { code: 0, stdout: "", stderr: "" };
};
const config = (): SandboxConfig => ({ codingRoot: root, image: "maipai-sandbox:test", allowedPorts: [8790], gatewayAddress: "192.0.2.1", idleMs: 60_000, startTimeoutMs: 200, pollMs: 1 });
const make = () => new SandboxService(fake, config(), () => now, fakeStream);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sbx-root-")); work = join(root, "person", "session", "work"); mkdirSync(work, { recursive: true });
  streamed = []; streamAborted = false; calls = []; machines = new Map(); lockOk = true; now = 1_000_000; networks = [];
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); setSandboxServiceForTests(undefined); });

test("the machine is started with the exact arguments: host-only network, no resolver, only NET_ADMIN added, one mount", async () => {
  const info = await make().create({ id: "sess-abc123", workspace: work });
  const run = calls.find((c) => c[0] === "run")!;
  expect(run).toEqual([
    "run", "-d", "--name", "maipai-sbx-sess-abc123", "--label", "maipai.sandbox=1",
    "--network", SANDBOX_NETWORK, "--no-dns", "--cpus", "4", "--memory", "4g", "--cap-add", "CAP_NET_ADMIN",
    "--mount", `type=bind,source=${info.workspace},target=/workspace`,
    "-e", "SANDBOX_ALLOW_ADDR=192.0.2.1", "-e", "SANDBOX_ALLOW_PORTS=8790", "maipai-sandbox:test",
  ]);
  expect(run.filter((a) => a === "--cap-add")).toHaveLength(1);
  expect(run.filter((a) => a === "--mount")).toHaveLength(1);
  expect(calls.find((c) => c[0] === "network" && c[1] === "create")).toEqual(["network", "create", "--internal", SANDBOX_NETWORK]);
  expect(info.state).toBe("running");
});

test("the person's variables are never a -e argument; one reserved variable carries them", async () => {
  await make().create({ id: "sess-env002", workspace: work, env: { PATH: "/work/bin", LD_PRELOAD: "/work/x.so", NOTE: "a b\nc" } });
  const run = calls.find((c) => c[0] === "run")!;
  const e = run.filter((_, i) => run[i - 1] === "-e");
  expect(e.some((v) => /^(PATH|LD_PRELOAD|NOTE)=/.test(v))).toBe(false);
  const carried = e.find((v) => v.startsWith("SANDBOX_WORKLOAD_ENV="))!;
  expect(Buffer.from(carried.split("=").slice(1).join("="), "base64").toString().split("\0")).toEqual(["PATH=/work/bin", "LD_PRELOAD=/work/x.so", "NOTE=a b\nc"]);
});

test("the host-only network is created once, not per sandbox", async () => {
  const service = make();
  await service.create({ id: "sess-aaa111", workspace: work });
  const other = join(root, "p2"); mkdirSync(other);
  await service.create({ id: "sess-bbb222", workspace: other });
  expect(calls.filter((c) => c[0] === "network" && c[1] === "create")).toHaveLength(1);
});

test("machine names come from the sandbox id only", () => {
  expect(machineName("sess-abc123")).toBe(`${MACHINE_PREFIX}sess-abc123`);
});

test("a lock that does not load is a typed failed start and the machine is removed", async () => {
  lockOk = false;
  const error = await make().create({ id: "sess-lock01", workspace: work }).catch((e) => e);
  expect(error).toBeInstanceOf(SandboxError);
  expect(error.code).toBe("lock_failed");
  expect(error.message).toContain("did not load");
  expect(calls.some((c) => c[0] === "delete" && c.includes("--force") && c.includes("maipai-sbx-sess-lock01"))).toBe(true);
  expect(machines.size).toBe(0);
});

test("cpus and memory default to 4 and 4 GB and are clamped", async () => {
  expect(clamp(undefined, 4, 1, 8)).toBe(4);
  expect(clamp(0, 4, 1, 8)).toBe(1);
  expect(clamp(99, 4, 1, 8)).toBe(8);
  expect(clamp(Number.NaN, 4, 1, 8)).toBe(4);
  const info = await make().create({ id: "sess-clamp1", workspace: work, cpus: 64, memory_gb: 0 });
  expect([info.cpus, info.memory_gb]).toEqual([8, 1]);
  expect(calls.find((c) => c[0] === "run")).toContain("1g");
});

test("workspace paths are rejected unless absolute, existing and inside the coding root", async () => {
  const service = make();
  const outside = mkdtempSync(join(tmpdir(), "sbx-out-"));
  const file = join(work, "a.txt"); writeFileSync(file, "x");
  symlinkSync(outside, join(root, "link"));
  const bad = ["relative/path", join(root, "missing"), file, root, outside, join(work, "..", "..", "..", ".."), join(root, "link"), `${work},target=/`];
  for (const workspace of bad) {
    const error = await service.create({ id: "sess-path01", workspace }).catch((e) => e);
    expect([workspace, error.code]).toEqual([workspace, "bad_workspace"]);
  }
  expect(calls.some((c) => c[0] === "run")).toBe(false);
  rmSync(outside, { recursive: true, force: true });
});

test("ids and variable names are checked", async () => {
  const service = make();
  expect((await service.create({ id: "Bad_ID", workspace: work }).catch((e) => e)).code).toBe("invalid_id");
  expect((await service.create({ id: "sess-env001", workspace: work, env: { SANDBOX_USER: "root" } }).catch((e) => e)).code).toBe("invalid_request");
  await service.create({ id: "sess-dup001", workspace: work });
  expect((await service.create({ id: "sess-dup001", workspace: work }).catch((e) => e)).code).toBe("exists");
});

test("a machine idle for the idle time is stopped; one that was read is not", async () => {
  const service = make();
  await service.create({ id: "sess-idle01", workspace: work });
  const other = join(root, "p2"); mkdirSync(other);
  await service.create({ id: "sess-busy01", workspace: other });
  now += 59_000;
  expect(await service.sweepIdle()).toEqual([]);
  service.get("sess-busy01");
  now += 2_000;
  expect(await service.sweepIdle()).toEqual(["sess-idle01"]);
  expect(machines.get("maipai-sbx-sess-idle01")).toBe("stopped");
  expect(service.list().find((s) => s.id === "sess-idle01")!.state).toBe("stopped");
});

test("stop and remove, and an unknown id is a plain not_found", async () => {
  const service = make();
  await service.create({ id: "sess-stop01", workspace: work });
  expect((await service.stop("sess-stop01")).state).toBe("stopped");
  await service.remove("sess-stop01");
  expect(machines.size).toBe(0);
  expect(service.list()).toEqual([]);
  expect((() => { try { service.get("sess-stop01"); } catch (e) { return e as SandboxError; } })()?.code).toBe("not_found");
});

test("the routes create, get, list, stop and delete, and refuse a bad path with 400", async () => {
  setSandboxServiceForTests(make());
  const headers = { "content-type": "application/json", host: "127.0.0.1" };
  const send = (path: string, method: string, body?: unknown) => app.request(`http://127.0.0.1/stack/v1/sandboxes${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const bad = await send("", "POST", { id: "sess-route1", workspace: "/etc" });
  expect(bad.status).toBe(400);
  expect((await send("", "POST", { id: "sess-route1", workspace: work })).status).toBe(201);
  expect((await send("/sess-route1", "GET")).status).toBe(200);
  expect(((await (await send("", "GET")).json()) as { sandboxes: unknown[] }).sandboxes).toHaveLength(1);
  expect((await send("/sess-route1/stop", "POST")).status).toBe(200);
  expect((await send("/sess-route1", "DELETE")).status).toBe(200);
  expect((await send("/sess-route1", "GET")).status).toBe(404);
});

const api = (path: string, method: string, body?: unknown, signal?: AbortSignal) => app.request(`http://127.0.0.1/stack/v1/sandboxes${path}`, { method, signal, headers: { "content-type": "application/json", host: "127.0.0.1" }, body: body ? JSON.stringify(body) : undefined });

test("exec streams ndjson lines then the exit, as the unprivileged user, env only as that process's arguments", async () => {
  setSandboxServiceForTests(make());
  await api("", "POST", { id: "sess-exec01", workspace: work });
  const res = await api("/sess-exec01/exec", "POST", { argv: ["echo", "a b"], cwd: "/workspace/sub/../src", env: { TOKEN: "s3cret" } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/x-ndjson");
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toEqual([{ stream: "stdout", text: "hi\n" }, { stream: "stderr", text: "oops\n" }, { exit: 0 }]);
  expect(streamed[0]).toEqual(["exec", "--user", "agent", "--workdir", "/workspace/src", "-e", "TOKEN=s3cret", "maipai-sbx-sess-exec01", "echo", "a b"]);
  // The value is in no other container call and in no create/list record.
  expect(JSON.stringify(calls)).not.toContain("s3cret");
  expect(JSON.stringify(await (await api("/sess-exec01", "GET")).json())).not.toContain("s3cret");
});

test("exec refuses a bad command, folder or variable name before running anything", async () => {
  setSandboxServiceForTests(make());
  await api("", "POST", { id: "sess-exec02", workspace: work });
  expect((await api("/sess-exec02/exec", "POST", { argv: [] })).status).toBe(400);
  expect((await api("/sess-exec02/exec", "POST", { argv: ["ls"], cwd: "/etc" })).status).toBe(400);
  expect((await api("/sess-exec02/exec", "POST", { argv: ["ls"], cwd: "/workspace/../etc" })).status).toBe(400);
  expect((await api("/sess-exec02/exec", "POST", { argv: ["ls"], env: { SANDBOX_USER: "root" } })).status).toBe(400);
  expect((await api("/sess-nope001/exec", "POST", { argv: ["ls"] })).status).toBe(404);
  expect(streamed).toEqual([]);
});

test("exec runs nothing when the lock marker is missing or the machine is stopped", async () => {
  const service = make(); setSandboxServiceForTests(service);
  await api("", "POST", { id: "sess-exec03", workspace: work });
  lockOk = false;
  const noLock = await api("/sess-exec03/exec", "POST", { argv: ["ls"] });
  expect(noLock.status).toBe(500);
  expect(((await noLock.json()) as { error: string }).error).toContain("lock");
  lockOk = true;
  await service.stop("sess-exec03");
  expect((await api("/sess-exec03/exec", "POST", { argv: ["ls"] })).status).toBe(409);
  expect(streamed).toEqual([]);
});

test("aborting the request reaches the streamer's signal (which kills the process group)", async () => {
  setSandboxServiceForTests(make());
  await api("", "POST", { id: "sess-exec04", workspace: work });
  const controller = new AbortController();
  const res = await api("/sess-exec04/exec", "POST", { argv: ["hang"] }, controller.signal);
  const reader = res.body!.getReader();
  await reader.read();
  controller.abort();
  await reader.read().catch(() => undefined);
  await Bun.sleep(20);
  expect(streamAborted).toBe(true);
});

test("snapshot clones the workspace, restore puts it back, and both need the lock", async () => {
  setSandboxServiceForTests(make());
  await api("", "POST", { id: "sess-snap01", workspace: work });
  mkdirSync(join(work, "src")); writeFileSync(join(work, "src", "a.txt"), "one"); writeFileSync(join(work, "b.txt"), "b");
  const made = await api("/sess-snap01/snapshots", "POST", { label: "before edit" });
  expect(made.status).toBe(201);
  const snap = (await made.json()) as { id: string; files: number };
  expect(snap.files).toBe(2);
  writeFileSync(join(work, "src", "a.txt"), "two"); writeFileSync(join(work, "extra.txt"), "x");
  const restored = await api(`/sess-snap01/snapshots/${snap.id}/restore`, "POST");
  expect(restored.status).toBe(200);
  expect(await restored.json()).toEqual({ ok: true });
  expect(readFileSync(join(work, "src", "a.txt"), "utf8")).toBe("one");
  expect(existsSync(join(work, "extra.txt"))).toBe(false);
  expect((await api("/sess-snap01/snapshots/snap-unknown-0000/restore", "POST")).status).toBe(404);
  expect((await api("/sess-snap01/snapshots/..%2Fx/restore", "POST")).status).toBe(400);
  expect((await api("/sess-snap01/snapshots", "POST", { label: "bad;label$(x)" })).status).toBe(400);
  lockOk = false;
  expect((await api("/sess-snap01/snapshots", "POST", { label: "x" })).status).toBe(500);
  expect((await api(`/sess-snap01/snapshots/${snap.id}/restore`, "POST")).status).toBe(500);
});

// Real machine: opt-in only (STACK_REAL_SANDBOX_TESTS=1 with the container system running and the image built).
test.skipIf(process.env.STACK_REAL_SANDBOX_TESTS !== "1")("real machine: exec prints and exits", async () => {
  const { realRunner, realStreamer, defaultConfig } = await import("@/lib/sandbox");
  const service = new SandboxService(realRunner, { ...defaultConfig(root), startTimeoutMs: 20_000 }, Date.now, realStreamer);
  await service.create({ id: "sess-real001", workspace: work });
  try {
    const out: ExecChunk[] = []; for await (const chunk of await service.exec("sess-real001", { argv: ["sh", "-c", "echo hi; exit 3"] }, new AbortController().signal)) out.push(chunk);
    expect(out).toEqual([{ stream: "stdout", text: "hi\n" }, { exit: 3 }]);
  } finally { await service.remove("sess-real001"); }
});
