import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { appendLogLine, registerLogSecret } from "@/lib/log";
import { dataDir } from "@/lib/paths";
import { __resetHealthForTests, list, raise } from "@/lib/health";
import { __resetOperatorForTests } from "@/lib/operator";

const logDir = join(dataDir, "logs");
const logName = `diagnostics-${Date.now()}`;

afterEach(() => {
  __resetHealthForTests();
  __resetOperatorForTests();
  if (existsSync(logDir)) for (const entry of readdirSync(logDir)) if (entry.startsWith(`${logName}.log`)) rmSync(join(logDir, entry), { force: true });
});

beforeEach(() => { __resetHealthForTests(); __resetOperatorForTests(); });

async function operatorHeaders() {
  const setup = await app.request("/stack/v1/operator/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse battery staple" }) });
  return { cookie: setup.headers.get("set-cookie")!.split(";", 1)[0]! };
}

test("a scripted failing health item is fixed by its action", async () => {
  raise({ code: "scripted-memory", severity: "warning", title: "Scripted memory pressure", text: "A scripted health item needs attention.", cause: "test", fix: { label: "Free memory", action: "free_memory" } });
  const response = await app.request("/stack/v1/health/scripted-memory/fix", { method: "POST", headers: await operatorHeaders() });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, result: "The chat engine was stopped to free memory." });
  expect(list()).toEqual([]);
});

test("the diagnostics bundle has its named files and no secret value", async () => {
  const secret = `diagnostics-secret-${"x".repeat(32)}`;
  registerLogSecret(secret);
  appendLogLine(`secret=${secret}`, logName);
  // The diagnostics route always bundles stack.log; seed it through the public logger too.
  appendLogLine(`secret=${secret}`);
  const response = await app.request("/stack/v1/logs/diagnostics", { headers: await operatorHeaders() });
  expect(response.headers.get("content-type")).toContain("application/zip");
  const text = new TextDecoder().decode(await response.arrayBuffer());
  for (const name of ["logs/stack.log", "health.json", "hardware.json", "settings.json", "versions.json"]) expect(text).toContain(name);
  expect(text).not.toContain(secret);
  expect(text).not.toContain("computerName");
});
