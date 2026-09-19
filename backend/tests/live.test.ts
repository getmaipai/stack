import { beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetLiveForTests, __setLiveReadersForTests, collectSample, getLastLiveSample, startLiveSampler, stopLiveSampler } from "@/lib/live";
import { __resetEventsForTests, eventsAfter } from "@/lib/events";
import { testClientHeaders } from "./authTest";

function macReaders() {
  return {
    ps: async () => ({ stdout: "1234 5.2 9:01AM 12 Jan 2026 llama-server\n", stderr: "" }),
    nvidiaSmi: async () => ({ stdout: "", stderr: "" }),
    systemProfiler: async () => ({
      stdout: JSON.stringify({ SPDisplaysDataType: { display0: { _name: "display0", sppci_model: "Apple M4" } } }),
      stderr: "",
    }),
    ioreg: async () => ({
      stdout: "+- Root | IOAccelerator\n  | \"Device Utilization %\" = 42\n",
      stderr: "",
    }),
    df: async () => ({ stdout: "Filesystem      1024-blocks      Used      Avail\n/dev/disk3s1     500000000  100000000  400000000\n", stderr: "" }),
  };
}

beforeEach(() => {
  __resetLiveForTests();
  __resetEventsForTests();
});

test("a Mac live sample has the GPU name from system_profiler, null memory, and utilization from ioreg", async () => {
  __setLiveReadersForTests(macReaders());
  const sample = await collectSample();
  const gpu = sample.gpus[0];
  expect(gpu).not.toBe(undefined);
  expect(gpu?.name).toBe("Apple M4");
  expect(gpu?.memoryUsedBytes).toBe(null);
  expect(gpu?.memoryTotalBytes).toBe(null);
  expect(gpu?.utilization).toBe(42);
});

test("the live event is emitted to the event stream", async () => {
  __setLiveReadersForTests(macReaders());
  startLiveSampler();
  await new Promise((resolve) => setTimeout(resolve, 100));
  stopLiveSampler();
  const events = eventsAfter(0);
  expect(events.some((event) => event.id === "live")).toBe(true);
});

test("GET /stack/v1/live returns the last sample", async () => {
  __setLiveReadersForTests(macReaders());
  startLiveSampler();
  await new Promise((resolve) => setTimeout(resolve, 100));
  stopLiveSampler();
  const response = await app.request("/stack/v1/live", { headers: testClientHeaders });
  expect(response.status).toBe(200);
  const body = await response.json() as { live: { gpus: { name: string; memoryUsedBytes: number | null; utilization: number | null }[]; at: string } };
  expect(body.live.gpus.length).toBeGreaterThan(0);
  const gpu = body.live.gpus[0]!;
  expect(gpu.name).toBe("Apple M4");
  expect(gpu.memoryUsedBytes).toBe(null);
  expect(gpu.utilization).toBe(42);
  expect(body.live.at).not.toBe("");
});

test("GET /stack/v1/live returns an empty sample before the first tick", async () => {
  __setLiveReadersForTests(macReaders());
  const response = await app.request("/stack/v1/live", { headers: testClientHeaders });
  expect(response.status).toBe(200);
  const body = await response.json() as { live: { processes: unknown[]; gpus: unknown[] } };
  expect(body.live.processes).toEqual([]);
  expect(body.live.gpus).toEqual([]);
});
