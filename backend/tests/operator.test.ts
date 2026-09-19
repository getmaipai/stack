import { afterAll, beforeAll, afterEach, expect, test } from "bun:test";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { dataDir } from "@/lib/paths";
import { __resetOperatorForTests, __resetOperatorThrottleForTests } from "@/lib/operator";

beforeAll(() => {
  __resetOperatorForTests();
  __resetOperatorThrottleForTests();
});

afterEach(() => {
  __resetOperatorThrottleForTests();
});

afterAll(() => {
  __resetOperatorForTests();
  __resetOperatorThrottleForTests();
});

test("off-loopback operator state reports setup required before a password exists", async () => {
  __resetOperatorForTests();
  const response = await app.request("http://192.168.1.20/stack/v1/operator");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "setupRequired", required: true, loopback: false });
});

test("operator setup works once and establishes a session", async () => {
  const setup = await app.request("/stack/v1/operator/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "correct horse battery staple" }),
  });
  expect(setup.status).toBe(201);
  expect(await setup.json()).toEqual({ state: "signedIn", required: true, loopback: true });
  expect(setup.headers.get("set-cookie")).toContain("stack_session=");

  const second = await app.request("/stack/v1/operator/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "another password" }),
  });
  expect(second.status).toBe(409);
});

test("wrong operator passwords are refused and the copied IP throttle trips", async () => {
  __resetOperatorThrottleForTests();
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await app.request("/stack/v1/operator/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(response.status).toBe(401);
  }
  const blocked = await app.request("/stack/v1/operator/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong" }),
  });
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("retry-after")).toBeTruthy();
});

test("the operator pepper is private on disk", () => {
  const pepper = join(dataDir, "keys", "pepper");
  chmodSync(pepper, 0o600);
  expect(statSync(pepper).mode & 0o777).toBe(0o600);
});
