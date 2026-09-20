import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { resourceSamples } from "@/db/schema";
import { __resetHostCpuForTests, __setHostCpuReaderForTests, hostCpuPercent } from "@/lib/hostCpu";
import { __resetLiveForTests, __setLiveReadersForTests, startLiveSampler, stopLiveSampler } from "@/lib/live";
import { __setMemoryReaderForTests } from "@/lib/memory";
import { scriptedMemoryReader } from "@/lib/memory/scripted";
import { pruneResourceSamples, readResourceSeries, recordResourcesSample, sampleResourcesOnce } from "@/lib/series";
import { getChatBackend, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { GOVERNOR_MEMORY_DEFAULT } from "./governorMemoryDefault";

function macReaders() {
  return {
    ps: async () => ({ stdout: "1234 5.2 9:01AM 12 Jan 2026 llama-server\n", stderr: "" }),
    nvidiaSmi: async () => ({ stdout: "", stderr: "" }),
    systemProfiler: async () => ({ stdout: JSON.stringify({ SPDisplaysDataType: { display0: { _name: "display0", sppci_model: "Apple M4" } } }), stderr: "" }),
    ioreg: async () => ({ stdout: "+- Root | IOAccelerator\n  | \"Device Utilization %\" = 37\n", stderr: "" }),
    df: async () => ({ stdout: "Filesystem      1024-blocks      Used      Avail      Mounted on\n/dev/disk3s1    500000000  100000000  400000000 /System/Volumes/Data\n", stderr: "" }),
    diskutil: async () => ({ stdout: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>VolumeName</key><string>Macintosh HD - Data</string></dict></plist>`, stderr: "" }),
  };
}

async function clearResourceSamples(): Promise<void> {
  db.delete(resourceSamples).run();
}

beforeEach(async () => {
  __resetLiveForTests();
  __resetHostCpuForTests();
  __setMemoryReaderForTests(scriptedMemoryReader([GOVERNOR_MEMORY_DEFAULT]));
  setSupervisorFactoryForTests(null);
  await clearResourceSamples();
});

test("a scripted live sample records one row per resource kind", async () => {
  __setLiveReadersForTests(macReaders());
  __setHostCpuReaderForTests(() => ({ idle: 8000, total: 10000 }));
  hostCpuPercent(); // seed the baseline snapshot
  __setHostCpuReaderForTests(() => ({ idle: 8500, total: 11000 })); // next tick: 50% busy
  setSupervisorFactoryForTests(async () => ({
    client: { baseUrl: "http://127.0.0.1:8142", complete: async () => ({ status: 200, body: {} }), health: async () => true },
    kind: "spawned", identity: { host: "local", build: "test", model: "chat.gguf", healthy: true }, pid: 1234, port: 8142, activeRequests: 0, retired: false, stop: async () => {},
  }));
  await getChatBackend();
  startLiveSampler();
  await new Promise((resolve) => setTimeout(resolve, 100));
  stopLiveSampler();
  await sampleResourcesOnce();
  const rows = db.select().from(resourceSamples).all();
  expect(rows).toHaveLength(4);
  const cpu = rows.find((row) => row.kind === "cpu");
  const memory = rows.find((row) => row.kind === "memory");
  const gpu = rows.find((row) => row.kind === "gpu");
  const storage = rows.find((row) => row.kind === "storage");
  expect(cpu?.percent).toBe(50);
  expect(memory?.usedBytes).toBe(GOVERNOR_MEMORY_DEFAULT.totalBytes - GOVERNOR_MEMORY_DEFAULT.freeBytes);
  expect(memory?.totalBytes).toBe(GOVERNOR_MEMORY_DEFAULT.totalBytes);
  expect(gpu?.percent).toBe(37);
  const gpuDevices = JSON.parse(gpu?.devices ?? "[]");
  expect(gpuDevices).toHaveLength(1);
  expect(gpuDevices[0]).toMatchObject({ index: 0, name: "Apple M4", utilization: 37 });
  const storageDevices = JSON.parse(storage?.devices ?? "[]");
  expect(storageDevices).toHaveLength(1);
  expect(storageDevices[0]).toMatchObject({ name: "Macintosh HD" });
});

test("no cached live sample yet still records a row, collecting one directly rather than writing an all-null row", async () => {
  __setLiveReadersForTests({
    ps: async () => ({ stdout: "", stderr: "" }),
    nvidiaSmi: async () => ({ stdout: "", stderr: "" }),
    systemProfiler: async () => ({ stdout: "{}", stderr: "" }),
    ioreg: async () => ({ stdout: "", stderr: "" }),
    df: async () => ({ stdout: "", stderr: "" }),
    diskutil: async () => ({ stdout: "", stderr: "" }),
  });
  await sampleResourcesOnce();
  const rows = db.select().from(resourceSamples).all();
  expect(rows).toHaveLength(4);
  expect(rows.find((row) => row.kind === "cpu")?.percent).toBe(null);
  expect(rows.find((row) => row.kind === "storage")?.devices).toBe(null);
});

test("empty buckets stay visible as null, never a fabricated zero", () => {
  const series = readResourceSeries("hour");
  expect(series.cpu).toHaveLength(60);
  for (const bucket of series.cpu) {
    expect(bucket.percent).toBe(null);
    expect(bucket.usedBytes).toBe(null);
    expect(bucket.totalBytes).toBe(null);
  }
  expect(series.devices.gpus).toEqual([]);
  expect(series.devices.drives).toEqual([]);
});

test("a recorded sample lands in its nearest bucket for every range", () => {
  recordResourcesSample({ cpuPercent: 12, memoryUsedBytes: 4 * 1_073_741_824, memoryTotalBytes: 16 * 1_073_741_824, gpus: [], drives: [] });
  for (const range of ["hour", "day", "week", "month"] as const) {
    const series = readResourceSeries(range);
    expect(series.cpu.some((bucket) => bucket.percent === 12)).toBe(true);
  }
});

test("month range has 120 six-hour buckets", () => {
  const series = readResourceSeries("month");
  expect(series.cpu).toHaveLength(120);
  const first = new Date(series.cpu[0]!.at).getTime();
  const second = new Date(series.cpu[1]!.at).getTime();
  expect(second - first).toBe(6 * 60 * 60_000);
});

test("retention deletes resource samples older than 35 days", async () => {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString();
  const recent = new Date().toISOString();
  recordResourcesSample({ at: old, cpuPercent: 1, memoryUsedBytes: null, memoryTotalBytes: null, gpus: [], drives: [] });
  recordResourcesSample({ at: recent, cpuPercent: 2, memoryUsedBytes: null, memoryTotalBytes: null, gpus: [], drives: [] });
  pruneResourceSamples();
  const rows = db.select().from(resourceSamples).where(eq(resourceSamples.kind, "cpu")).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.percent).toBe(2);
});
