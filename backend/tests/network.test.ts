import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetNetworkCacheForTests, __resetNetworkReadersForTests, __setNetworkReadersForTests, readNetworkSignal } from "@/lib/network";
import { testClientHeaders } from "./authTest";

const originalPlatform = process.platform;
function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value });
}

beforeEach(() => {
  __resetNetworkReadersForTests();
  __resetNetworkCacheForTests();
});
afterEach(() => {
  setPlatform(originalPlatform);
  __resetNetworkReadersForTests();
  __resetNetworkCacheForTests();
});

test("macOS: parses the default interface, gateway, and link speed", async () => {
  setPlatform("darwin");
  __setNetworkReadersForTests({
    routeGet: async () => ({ stdout: "   route to: default\ndestination: default\n       mask: default\n    gateway: 192.0.2.1\n  interface: en0\n", stderr: "" }),
    ifconfig: async () => ({ stdout: "en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500\n\tmedia: autoselect (1000baseT <full-duplex>)\n\tstatus: active\n", stderr: "" }),
    gatewayConnect: async () => 12,
  });
  const signal = await readNetworkSignal();
  expect(signal.interface).toBe("en0");
  expect(signal.linkMbps).toBe(1000);
  expect(signal.gatewayMs).toBe(12);
});

test("macOS: a Wi-Fi media line with no rate reads null link speed", async () => {
  setPlatform("darwin");
  __setNetworkReadersForTests({
    routeGet: async () => ({ stdout: "gateway: 192.0.2.1\ninterface: en1\n", stderr: "" }),
    ifconfig: async () => ({ stdout: "en1: flags=8863<UP> mtu 1500\n\tmedia: autoselect\n\tstatus: active\n", stderr: "" }),
    gatewayConnect: async () => null,
  });
  const signal = await readNetworkSignal();
  expect(signal.linkMbps).toBe(null);
  expect(signal.gatewayMs).toBe(null);
});

test("Linux: parses the default route from /proc/net/route and the speed file", async () => {
  setPlatform("linux");
  __setNetworkReadersForTests({
    procNetRoute: async () =>
      "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n" +
      "eth0\t00000000\t0102A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\n",
    sysClassNetSpeed: async () => "2500\n",
    gatewayConnect: async () => 8,
  });
  const signal = await readNetworkSignal();
  expect(signal.interface).toBe("eth0");
  expect(signal.linkMbps).toBe(2500);
  expect(signal.gatewayMs).toBe(8);
});

test("a failed route command reads every field null", async () => {
  setPlatform("darwin");
  __setNetworkReadersForTests({
    routeGet: async () => {
      throw new Error("no such device");
    },
  });
  const signal = await readNetworkSignal();
  expect(signal.interface).toBe(null);
  expect(signal.linkMbps).toBe(null);
  expect(signal.gatewayMs).toBe(null);
});

test("gateway latency is the median of the successful samples", async () => {
  setPlatform("darwin");
  let call = 0;
  __setNetworkReadersForTests({
    routeGet: async () => ({ stdout: "gateway: 192.0.2.1\ninterface: en0\n", stderr: "" }),
    ifconfig: async () => ({ stdout: "media: autoselect (100baseTX <full-duplex>)\n", stderr: "" }),
    gatewayConnect: async () => {
      call += 1;
      return [20, 10, 30][call - 1] ?? null;
    },
  });
  const signal = await readNetworkSignal();
  expect(signal.gatewayMs).toBe(20);
});

test("the reading is cached for 30 seconds", async () => {
  setPlatform("darwin");
  let calls = 0;
  __setNetworkReadersForTests({
    routeGet: async () => {
      calls += 1;
      return { stdout: "gateway: 192.0.2.1\ninterface: en0\n", stderr: "" };
    },
    ifconfig: async () => ({ stdout: "media: autoselect (100baseTX)\n", stderr: "" }),
    gatewayConnect: async () => 5,
  });
  await readNetworkSignal();
  await readNetworkSignal();
  expect(calls).toBe(1);
});

test("GET /stack/v1/network requires client or operator auth and returns the signal", async () => {
  setPlatform("darwin");
  __setNetworkReadersForTests({
    routeGet: async () => ({ stdout: "gateway: 192.0.2.1\ninterface: en0\n", stderr: "" }),
    ifconfig: async () => ({ stdout: "media: autoselect (1000baseT <full-duplex>)\n", stderr: "" }),
    gatewayConnect: async () => 9,
  });
  const unauthorized = await app.request("/stack/v1/network");
  expect(unauthorized.status).toBe(401);
  const response = await app.request("/stack/v1/network", { headers: testClientHeaders });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { interface: string | null; linkMbps: number | null; gatewayMs: number | null; measuredAt: string };
  expect(body.interface).toBe("en0");
  expect(body.linkMbps).toBe(1000);
  expect(body.gatewayMs).toBe(9);
  expect(typeof body.measuredAt).toBe("string");
});
