import { expect, test } from "bun:test";
import { llamaServerArgs } from "@/lib/engineArgs";

const modelPath = "/models/chat.gguf";
const declaredDefaults: Record<string, number | boolean | string> = {
  contextLength: 4096,
  slots: 1,
  threads: 0,
  cacheRamMb: 0,
  flashAttention: true,
};

test("a Mac spawn gets the hub's full launch list over the declared defaults", () => {
  const args = llamaServerArgs({ modelPath, port: 8771, config: declaredDefaults, contextLength: 4096, kvCacheQuantized: true });
  expect(args).toEqual([
    "--model", modelPath,
    "--port", "8771",
    "--host", "127.0.0.1",
    "-c", "4096",
    "-fa", "on",
    "-ngl", "all",
    "--reasoning", "off",
    "-ub", "1024",
    "--no-webui",
    "--metrics",
    "--jinja",
    "--cache-reuse", "256",
    "-ctk", "q8_0",
    "-ctv", "q8_0",
  ]);
});

test("flashAttention false spells -fa off", () => {
  const args = llamaServerArgs({ modelPath, port: 8771, config: { ...declaredDefaults, flashAttention: false }, contextLength: 4096, kvCacheQuantized: true });
  const fa = args.indexOf("-fa");
  expect(args[fa + 1]).toBe("off");
});

test("declared slots, threads and cache RAM are spelled only when above one or zero", () => {
  const args = llamaServerArgs({ modelPath, port: 8771, config: { ...declaredDefaults, slots: 2, threads: 8, cacheRamMb: 512 }, contextLength: 4096, kvCacheQuantized: true });
  expect(args).toContain("--parallel");
  const p = args.indexOf("--parallel");
  expect(args[p + 1]).toBe("2");
  const t = args.indexOf("--threads");
  expect(args[t + 1]).toBe("8");
  const c = args.indexOf("--cache-ram-mb");
  expect(args[c + 1]).toBe("512");
});

test("without KV quantization the -ctk/-ctv pair is absent", () => {
  const args = llamaServerArgs({ modelPath, port: 8771, config: declaredDefaults, contextLength: 4096, kvCacheQuantized: false });
  expect(args).not.toContain("-ctk");
  expect(args).not.toContain("-ctv");
  expect(args[args.length - 2]).toBe("--cache-reuse");
  expect(args[args.length - 1]).toBe("256");
});

test("a small declared context caps -ub at it", () => {
  const args = llamaServerArgs({ modelPath, port: 8771, config: declaredDefaults, contextLength: 512, kvCacheQuantized: true });
  const c = args.indexOf("-c");
  expect(args[c + 1]).toBe("512");
  const ub = args.indexOf("-ub");
  expect(args[ub + 1]).toBe("512");
});
