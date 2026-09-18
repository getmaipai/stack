import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { __resetChecksForTests } from "@/lib/checkMyStack";
import { __resetEventsForTests, eventsAfter } from "@/lib/events";
import { __resetHealthForTests } from "@/lib/health";
import { __resetOperatorForTests, __resetOperatorThrottleForTests } from "@/lib/operator";

let dataDir: string | null = null;

beforeEach(() => {
  dataDir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "maipai-check-route-"));
  process.env.STACK_DATA_DIR = dataDir;
  process.env.STACK_SCRIPTED_ENGINES = "1";
  __resetOperatorForTests(); __resetOperatorThrottleForTests(); __resetChecksForTests(); __resetEventsForTests(); __resetHealthForTests();
});

afterEach(() => {
  __resetOperatorForTests(); __resetOperatorThrottleForTests(); __resetChecksForTests(); __resetEventsForTests(); __resetHealthForTests();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
  delete process.env.STACK_SCRIPTED_ENGINES;
});

async function operatorCookie(): Promise<string> {
  const response = await app.request("/stack/v1/operator/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test password" }) });
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

test("the check endpoint starts a job, reports progress, and finishes with the result", async () => {
  const cookie = await operatorCookie();
  const headers = { cookie, "content-type": "application/json" };
  const started = await app.request("/stack/v1/check", { method: "POST", headers, body: JSON.stringify({}) });
  expect(started.status).toBe(202);
  const body = (await started.json()) as { runId: string; state: string };
  expect(body.state).toBe("running");
  expect(typeof body.runId).toBe("string");
  let done = false;
  while (!done) {
    const running = await app.request("/stack/v1/check/latest", { headers: { cookie } });
    expect(running.status).toBe(200);
    const runningBody = (await running.json()) as { state?: string; startedAt?: string; ok?: boolean };
    if (runningBody.state === "running") {
      expect(typeof runningBody.startedAt).toBe("string");
      const second = await app.request("/stack/v1/check", { method: "POST", headers, body: JSON.stringify({}) });
      expect(second.status).toBe(409);
      expect((await second.json() as { error: string }).error).toBe("A check is already running.");
    } else {
      done = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const checkEvents = eventsAfter(0).filter((event) => event.id === "check.progress" || event.id === "check.done");
  expect(checkEvents.filter((event) => event.id === "check.progress" && (event.data.role as string) === "chat" && (event.data.state as string) === "passed")).toHaveLength(1);
  expect(checkEvents.some((event) => event.id === "check.done" && event.data.ok === true)).toBe(true);
  const finalResponse = await app.request("/stack/v1/check/latest", { headers: { cookie } });
  expect(finalResponse.status).toBe(200);
  const doneBody = (await finalResponse.json()) as { state?: string; ok: boolean; results: unknown[] };
  expect(doneBody.ok).toBe(true);
  expect(doneBody.state).toBeUndefined();
});
