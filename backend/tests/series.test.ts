import { afterEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetOperatorForTests } from "@/lib/operator";

const originalShowroom = process.env.STACK_SHOWROOM;
const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => { if (originalShowroom === undefined) delete process.env.STACK_SHOWROOM; else process.env.STACK_SHOWROOM = originalShowroom; if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv; });
afterEach(() => __resetOperatorForTests());

test("GET /stack/v1/series honors the selected range on scripted data", async () => {
  process.env.STACK_SHOWROOM = "1";
  process.env.NODE_ENV = "development";
  const setup = await app.request("/stack/v1/operator/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse battery staple" }) });
  const headers = { cookie: setup.headers.get("set-cookie")!.split(";", 1)[0]! };
  const hour = await app.request("/stack/v1/series?range=hour", { headers });
  const week = await app.request("/stack/v1/series?range=week", { headers });
  expect(hour.status).toBe(200);
  expect(week.status).toBe(200);
  const hourBody = await hour.json() as { range: string; usage: unknown[]; memory: unknown[]; speed: unknown[] };
  const weekBody = await week.json() as { range: string; usage: unknown[]; memory: unknown[]; speed: unknown[] };
  expect(hourBody.range).toBe("hour");
  expect(weekBody.range).toBe("week");
  expect(hourBody.usage.length).toBeLessThan(weekBody.usage.length);
  expect(hourBody.memory.length).toBeGreaterThan(0);
  expect(hourBody.speed.length).toBeGreaterThan(0);
});
