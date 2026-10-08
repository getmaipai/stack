import { afterEach, expect, test } from "bun:test";
import { ENGINE_BINARIES, installedEnginePin, selectEngineBinary } from "@/lib/engineCatalog";

const originalPlatform = process.platform;
const originalArch = process.arch;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  Object.defineProperty(process, "arch", { value: originalArch });
});

test("the pinned b11476 CUDA runtime checksum matches the release archive", () => {
  const pin = ENGINE_BINARIES.find((candidate) => candidate.id === "llama-server-b11476-linux-cuda-x64")!;
  expect(pin.extraArchives?.find((archive) => archive.label === "CUDA 12.8 runtime (cudart)")?.sha256)
    .toBe("768e0ed4089b76642c8111558c6a8bb6521fc4171e88c1ae850e3d661370d0f3");
});

test("installedEnginePin recognizes the installed Linux CUDA llama-server pin", () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  Object.defineProperty(process, "arch", { value: "x64" });
  expect(installedEnginePin()).toMatchObject({
    id: "llama-server-b11476-linux-cuda-x64",
    name: "llama-server",
    requiresNvidia: true,
  });
});
