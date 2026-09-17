import { describe, expect, test, beforeEach } from "bun:test";
import { app } from "@/app";
import {
  getClientIp,
  throttleCheck,
  throttleFail,
  throttleReset,
  __resetThrottleForTests,
} from "@/lib/secretThrottle";

const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 20;

beforeEach(() => {
  __resetThrottleForTests();
});

describe("throttleCheck", () => {
  test("returns not blocked for a fresh IP", () => {
    expect(throttleCheck("1.2.3.4")).toEqual({ blocked: false, retryAfter: 0 });
  });

  test("returns not blocked after a few failures", () => {
    for (let i = 0; i < 5; i++) throttleFail("1.2.3.4");
    expect(throttleCheck("1.2.3.4")).toEqual({ blocked: false, retryAfter: 0 });
  });

  test("blocks after MAX_FAILS failures", () => {
    for (let i = 0; i < MAX_FAILS; i++) throttleFail("1.2.3.4");
    const result = throttleCheck("1.2.3.4");
    expect(result.blocked).toBe(true);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.retryAfter).toBeLessThanOrEqual(WINDOW_MS / 1000);
  });

  test("does not block other IPs", () => {
    for (let i = 0; i < MAX_FAILS; i++) throttleFail("1.2.3.4");
    expect(throttleCheck("5.6.7.8")).toEqual({ blocked: false, retryAfter: 0 });
  });
});

describe("throttleFail", () => {
  test("accumulates failures per IP", () => {
    throttleFail("1.2.3.4");
    throttleFail("1.2.3.4");
    throttleFail("1.2.3.4");
    expect(throttleCheck("1.2.3.4").blocked).toBe(false);
  });

  test("crosses the threshold on the max-th failure", () => {
    for (let i = 0; i < MAX_FAILS - 1; i++) throttleFail("9.9.9.9");
    expect(throttleCheck("9.9.9.9").blocked).toBe(false);
    throttleFail("9.9.9.9");
    expect(throttleCheck("9.9.9.9").blocked).toBe(true);
  });
});

describe("throttleReset", () => {
  test("clears the bucket for the given IP", () => {
    for (let i = 0; i < MAX_FAILS; i++) throttleFail("1.2.3.4");
    expect(throttleCheck("1.2.3.4").blocked).toBe(true);
    throttleReset("1.2.3.4");
    expect(throttleCheck("1.2.3.4")).toEqual({ blocked: false, retryAfter: 0 });
  });

  test("does not clear other IPs", () => {
    for (let i = 0; i < MAX_FAILS; i++) throttleFail("1.2.3.4");
    for (let i = 0; i < MAX_FAILS; i++) throttleFail("5.6.7.8");
    throttleReset("1.2.3.4");
    expect(throttleCheck("1.2.3.4")).toEqual({ blocked: false, retryAfter: 0 });
    expect(throttleCheck("5.6.7.8").blocked).toBe(true);
  });
});

describe("__resetThrottleForTests", () => {
  test("clears all buckets", () => {
    for (let i = 0; i < MAX_FAILS; i++) throttleFail("1.2.3.4");
    for (let i = 0; i < MAX_FAILS; i++) throttleFail("5.6.7.8");
    __resetThrottleForTests();
    expect(throttleCheck("1.2.3.4")).toEqual({ blocked: false, retryAfter: 0 });
    expect(throttleCheck("5.6.7.8")).toEqual({ blocked: false, retryAfter: 0 });
  });
});

describe("getClientIp", () => {
  test("ignores x-forwarded-for when STACK_TRUST_PROXY is unset", () => {
    const original = process.env.STACK_TRUST_PROXY;
    delete process.env.STACK_TRUST_PROXY;
    const c = { req: { header: (name: string) => "10.0.0.1, 172.16.0.1" } };
    const ip = getClientIp(c as any);
    expect(ip).toBe("unknown");
    if (original === undefined) delete process.env.STACK_TRUST_PROXY;
    else process.env.STACK_TRUST_PROXY = original;
  });

  test("uses the first x-forwarded-for address when STACK_TRUST_PROXY is set", () => {
    const original = process.env.STACK_TRUST_PROXY;
    process.env.STACK_TRUST_PROXY = "true";
    const c = { req: { header: (name: string) => "10.0.0.1, 172.16.0.1" } };
    const ip = getClientIp(c as any);
    expect(ip).toBe("10.0.0.1");
    if (original === undefined) delete process.env.STACK_TRUST_PROXY;
    else process.env.STACK_TRUST_PROXY = original;
  });
});
