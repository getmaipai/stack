import { afterEach, expect, test } from "bun:test";
import { DdgsSupervisor, ddgsRequirementsFileFor, DDGS_HEALTH_CODE, type DdgsDeps } from "@/search/ddgsSidecar";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";

afterEach(() => { __resetHealthForTests(); });

function deps(over: Partial<DdgsDeps> = {}): DdgsDeps {
  return {
    requirements: () => "requirements.txt",
    ensureEnvironment: async () => {},
    port: async () => 41234,
    spawn: async () => { let end!: (code: number) => void; const exited = new Promise<number>((done) => { end = done; }); return { exited, kill: () => end(143), stderrTail: () => "" }; },
    healthy: async () => true,
    sleep: (ms, signal) => new Promise((done) => { const t = setTimeout(done, Math.min(ms, 5)); signal.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true }); }),
    now: Date.now,
    ...over,
  };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); expect(check()).toBe(true); };

test("a healthy sidecar is ready and its loopback address is published", async () => {
  const supervisor = new DdgsSupervisor(deps());
  supervisor.start();
  await until(() => supervisor.get().state === "ready");
  expect(supervisor.get().url).toBe("http://127.0.0.1:41234/");
  await supervisor.stop();
});

test("a failed environment build is a health item that says what to do, and the next try recovers it", async () => {
  let attempts = 0;
  const supervisor = new DdgsSupervisor(deps({ ensureEnvironment: async () => { attempts += 1; if (attempts === 1) throw new Error("uv exited 2: network unreachable"); } }));
  supervisor.start();
  await until(() => listHealth().some((item) => item.code === DDGS_HEALTH_CODE));
  const item = listHealth().find((candidate) => candidate.code === DDGS_HEALTH_CODE)!;
  expect(item.text).toContain("network unreachable");
  expect(item.text).toContain("internet connection");
  expect(item.fix?.action).toBe("retry_download");
  supervisor.retryNow();
  await until(() => supervisor.get().state === "ready");
  await until(() => !listHealth().some((candidate) => candidate.code === DDGS_HEALTH_CODE));
  await supervisor.stop();
});

test("a process that dies is restarted, and one that keeps dying raises a health item", async () => {
  let spawns = 0;
  const supervisor = new DdgsSupervisor(deps({ spawn: async () => { spawns += 1; return { exited: Promise.resolve(1), kill: () => {}, stderrTail: () => "ImportError: no module named ddgs" }; }, healthy: async () => false }));
  supervisor.start();
  await until(() => spawns >= 3);
  await until(() => listHealth().some((item) => item.code === DDGS_HEALTH_CODE));
  expect(listHealth()[0]!.text).toContain("ImportError");
  expect(supervisor.get().url).toBeNull();
  await supervisor.stop();
});

test("a platform with no requirements file is unsupported, not failed, and raises nothing", () => {
  const supervisor = new DdgsSupervisor(deps({ requirements: () => null }));
  supervisor.start();
  expect(supervisor.get().state).toBe("unsupported");
  expect(listHealth()).toHaveLength(0);
});

test("the requirements file is hashed and pins ddgs", async () => {
  const text = await Bun.file(ddgsRequirementsFileFor("darwin", "arm64")!).text();
  expect(text).toContain("ddgs==9.16.0");
  expect(text).toContain("--hash=sha256:");
  expect(ddgsRequirementsFileFor("linux", "x64")).toBeNull();
});
