import { beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetLiveForTests, __setLiveReadersForTests, collectSample, getLastLiveSample, startLiveSampler, stopLiveSampler } from "@/lib/live";
import { __resetEventsForTests, eventsAfter } from "@/lib/events";
import { getChatBackend, setSupervisorFactoryForTests } from "@/lib/supervisor";
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
  setSupervisorFactoryForTests(null);
});

test("a running process uses the supervisor port and an ISO start time", async () => {
  __setLiveReadersForTests({
    ...macReaders(),
    ps: async () => ({ stdout: "1234 5.2 Fri Sep 18 20:15:57 2026 llama-server\n", stderr: "" }),
  });
  setSupervisorFactoryForTests(async () => ({
    client: { baseUrl: "http://127.0.0.1:8142", complete: async () => ({ status: 200, body: {} }), health: async () => true },
    kind: "spawned", identity: { host: "local", build: "test", model: "chat.gguf", healthy: true }, pid: 1234, port: 8142, activeRequests: 0, retired: false, stop: async () => {},
  }));
  await getChatBackend();
  const sample = await collectSample();
  expect(sample.processes).toHaveLength(1);
  expect(sample.processes[0]?.port).toBe(8142);
  expect(sample.processes[0]?.startedAt).toBe(new Date("Fri Sep 18 20:15:57 2026").toISOString());
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
