import { beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetLiveForTests, __setLiveClockForTests, __setLiveReadersForTests, collectSample, getLastLiveSample, startLiveSampler, stopLiveSampler } from "@/lib/live";
import { __resetEventsForTests, eventsAfter } from "@/lib/events";
import { getChatBackend, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { __resetStackSettingsForTests, updateStackConfig } from "@/settings/stackKeys";
import { testClientHeaders } from "./authTest";

function macReaders(options: { volumeName?: string } = {}) {
  const volumeName = options.volumeName ?? "Macintosh HD - Data";
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
    df: async () => ({ stdout: "Filesystem      1024-blocks      Used      Avail      Mounted on\n/dev/disk3s1    500000000  100000000  400000000 /System/Volumes/Data\n/dev/disk4     300000000   50000000  250000000 /Volumes/photo\n/dev/disk5     200000000   10000000  190000000 /Volumes/UTM\n/dev/disk6     400000000   20000000  380000000 /System/Volumes/VM\n", stderr: "" }),
    diskutil: async () => ({
      stdout: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>VolumeName</key>\n\t<string>${volumeName}</string>\n</dict>\n</plist>\n`,
      stderr: "",
    }),
  };
}

beforeEach(() => {
  __resetLiveForTests();
  __resetEventsForTests();
  setSupervisorFactoryForTests(null);
  __resetStackSettingsForTests();
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

function waitForSample(at: string | null): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const sample = getLastLiveSample();
      if (at === null ? sample !== null : sample !== null && sample.at === at) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });
}

test("a sample exists before the first tick, and the Mac GPU name is read once", async () => {
  let now = 0;
  __setLiveClockForTests(() => now);
  let profilerCalls = 0;
  const readers = macReaders();
  __setLiveReadersForTests({
    ...readers,
    systemProfiler: async () => { profilerCalls += 1; return readers.systemProfiler(); },
  });
  startLiveSampler();
  // The immediate sample is taken on start, before the first interval tick.
  await waitForSample(null);
  expect(getLastLiveSample()).not.toBeNull();
  expect(getLastLiveSample()?.at).toBe(new Date(0).toISOString());
  // Subsequent collectSample calls (what the interval would produce) reuse the GPU name.
  now = 5000;
  const s2 = await collectSample();
  expect(s2.at).toBe(new Date(5000).toISOString());
  now = 10000;
  const s3 = await collectSample();
  expect(s3.at).toBe(new Date(10000).toISOString());
  stopLiveSampler();
  expect(profilerCalls).toBe(1);
  expect(s3.gpus[0]?.name).toBe("Apple M4");
});

test("the sampler lists every user-visible mounted volume and drops system volumes", async () => {
  __setLiveReadersForTests(macReaders());
  const sample = await collectSample();
  const mounts = sample.drives.map((d) => d.mount).sort();
  expect(mounts).toEqual(["/", "/Volumes/UTM", "/Volumes/photo"]);
  for (const drive of sample.drives) {
    expect(drive.mounted).toBe(true);
  }
  const startup = sample.drives.find((d) => d.mount === "/");
  expect(startup?.name).toBe("Macintosh HD");
  expect(startup?.usedBytes).toBe(100_000_000 * 1024);
  expect(startup?.totalBytes).toBe(500_000_000 * 1024);
  const photo = sample.drives.find((d) => d.mount === "/Volumes/photo");
  expect(photo?.name).toBe("photo");
  expect(photo?.totalBytes).toBe(300_000_000 * 1024);
  expect(photo?.usedBytes).toBe(50_000_000 * 1024);
});

test("a renamed Mac startup disk takes its name from diskutil, not an assumption", async () => {
  __setLiveReadersForTests(macReaders({ volumeName: "Studio - Data" }));
  const sample = await collectSample();
  const startup = sample.drives.find((d) => d.mount === "/");
  expect(startup?.name).toBe("Studio");
});

test("the storageDrives setting chooses the startup disk by its Finder mount", async () => {
  __setLiveReadersForTests(macReaders());
  updateStackConfig({ storageDrives: "/" });
  const sample = await collectSample();
  expect(sample.drives.map((d) => d.mount)).toEqual(["/"]);
  expect(sample.drives[0]?.name).toBe("Macintosh HD");
});

test("a storageDrives setting hides the drives it does not choose, everywhere the sampler reports", async () => {
  __setLiveReadersForTests(macReaders());
  updateStackConfig({ storageDrives: "/Volumes/photo,/Volumes/UTM" });
  const sample = await collectSample();
  const mounts = sample.drives.map((d) => d.mount).sort();
  expect(mounts).toEqual(["/Volumes/UTM", "/Volumes/photo"]);
  expect(sample.drives.some((d) => d.mount === "/")).toBe(false);
});

test("an unmounted chosen drive is returned with mounted false and zero sizes", async () => {
  __setLiveReadersForTests(macReaders());
  updateStackConfig({ storageDrives: "/Volumes/photo,/Volumes/UTM,/Volumes/gone" });
  const sample = await collectSample();
  const gone = sample.drives.find((d) => d.mount === "/Volumes/gone");
  expect(gone).not.toBe(undefined);
  expect(gone?.mounted).toBe(false);
  expect(gone?.usedBytes).toBe(0);
  expect(gone?.totalBytes).toBe(0);
  expect(gone?.name).toBe("gone");
});
