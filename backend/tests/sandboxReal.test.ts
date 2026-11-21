// CODE-SANDBOX-02: the five-check network gate, run as root inside a real machine behind the real lock.
// Opt in with MAIPAI_SANDBOX_REAL=1 (the container system must be running; this builds backend/sandbox/Containerfile).
// Optional: GATE_LAN_ADDR for check 2. The test listens on two hub ports (one allowed, one forbidden) on all addresses.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxService, defaultConfig, realRunner } from "@/lib/sandbox";

const real = process.env.MAIPAI_SANDBOX_REAL === "1";

test.skipIf(!real)("the gate probe passes as root behind the lock, and the allowed port still works", async () => {
  const build = await realRunner(["build", "-t", "maipai-sandbox:test", "-f", join(import.meta.dir, "..", "sandbox", "Containerfile"), join(import.meta.dir, "..", "sandbox")], { timeoutMs: 600_000 });
  expect(build.stderr + build.stdout).not.toContain("Error");
  const root = mkdtempSync(join(tmpdir(), "sbx-real-")); mkdirSync(join(root, "work"));
  const allowed = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {}, open(s) { s.end(); } } });
  const forbidden = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {}, open(s) { s.end(); } } });
  const service = new SandboxService(realRunner, { ...defaultConfig(root), image: "maipai-sandbox:test", allowedPorts: [allowed.port], gatewayAddress: undefined, startTimeoutMs: 60_000, pollMs: 500 });
  const env = { GATE_ALLOWED_PORT: String(allowed.port), GATE_FORBIDDEN_PORT: String(forbidden.port), ...(process.env.GATE_LAN_ADDR ? { GATE_LAN_ADDR: process.env.GATE_LAN_ADDR } : {}) };
  try {
    // The probe is the workload (it then sleeps so the machine stays up for the log read), run as root behind the dropped rights. GATE_GATEWAY is read from the machine's own default route.
    const info = await service.create({ id: "gate-real-01", workspace: join(root, "work"), runAs: "root", env, workload: ["sh", "-c", "GATE_GATEWAY=$SANDBOX_ALLOW_ADDR /usr/local/sbin/gate-probe; echo EXIT=$?; sleep 600"] });
    expect(info.state).toBe("running");
    let out = "";
    for (let i = 0; i < 40 && !out.includes("EXIT="); i++) { await Bun.sleep(500); out = await service.logs("gate-real-01"); }
    expect(out).not.toContain("FAIL");
    expect(out).toContain("EXIT=0");
  } finally {
    await service.remove("gate-real-01").catch(() => undefined);
    allowed.stop(true); forbidden.stop(true); rmSync(root, { recursive: true, force: true });
  }
}, 700_000);

test.skipIf(!real)("a person's PATH, LD_PRELOAD and fake nft and capsh in the workspace cannot replace the lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "sbx-real-")); const work = join(root, "work"); mkdirSync(join(work, "bin"), { recursive: true });
  for (const name of ["nft", "capsh"]) { writeFileSync(join(work, "bin", name), "#!/bin/sh\nexit 0\n"); chmodSync(join(work, "bin", name), 0o755); }
  writeFileSync(join(work, "x.so"), "not a library");
  const allowed = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {}, open(s) { s.end(); } } });
  const forbidden = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {}, open(s) { s.end(); } } });
  const service = new SandboxService(realRunner, { ...defaultConfig(root), image: "maipai-sandbox:test", allowedPorts: [allowed.port], gatewayAddress: undefined, startTimeoutMs: 60_000, pollMs: 500 });
  const env = { PATH: "/work/bin", LD_PRELOAD: "/work/x.so", GATE_ALLOWED_PORT: String(allowed.port), GATE_FORBIDDEN_PORT: String(forbidden.port) };
  try {
    await service.create({ id: "gate-real-02", workspace: work, runAs: "root", env, workload: ["sh", "-c", "echo SEEN_PATH=$PATH; PATH=/usr/sbin:/usr/bin:/sbin:/bin GATE_GATEWAY=$SANDBOX_ALLOW_ADDR /usr/local/sbin/gate-probe; echo EXIT=$?; sleep 600"] });
    let out = "";
    for (let i = 0; i < 40 && !out.includes("EXIT="); i++) { await Bun.sleep(500); out = await service.logs("gate-real-02"); }
    expect(out).toContain("SEEN_PATH=/work/bin");
    expect(out).not.toContain("FAIL");
    expect(out).toContain("EXIT=0");
  } finally {
    await service.remove("gate-real-02").catch(() => undefined);
    allowed.stop(true); forbidden.stop(true); rmSync(root, { recursive: true, force: true });
  }
}, 700_000);
