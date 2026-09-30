import { expect, test } from "bun:test";
import { defaultKvCacheType, kvCacheTypeFor, llamaServerArgs } from "@/lib/engineArgs";

const modelPath = "/models/chat.gguf";
const declaredDefaults: Record<string, number | boolean | string> = {
  contextLength: 4096,
  slots: 1,
  threads: 0,
  cacheRamMb: 0,
  flashAttention: true,
};

test("a Mac spawn gets the hub's full launch list over the declared defaults", () => {
  const args = llamaServerArgs({ modelPath, port: 8771, config: declaredDefaults, contextLength: 4096, kvCacheType: "q8_0" });
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
  const args = llamaServerArgs({ modelPath, port: 8771, config: { ...declaredDefaults, flashAttention: false }, contextLength: 4096, kvCacheType: "q8_0" });
  const fa = args.indexOf("-fa");
  expect(args[fa + 1]).toBe("off");
});

test("declared slots, threads and cache RAM are spelled only when above one or zero", () => {
  const args = llamaServerArgs({ modelPath, port: 8771, config: { ...declaredDefaults, slots: 2, threads: 8, cacheRamMb: 512 }, contextLength: 4096, kvCacheType: "q8_0" });
  expect(args).toContain("--parallel");
  const p = args.indexOf("--parallel");
  expect(args[p + 1]).toBe("2");
  const t = args.indexOf("--threads");
  expect(args[t + 1]).toBe("8");
  const c = args.indexOf("--cache-ram-mb");
  expect(args[c + 1]).toBe("512");
});

test("without KV quantization the -ctk/-ctv pair is absent", () => {
  const args = llamaServerArgs({ modelPath, port: 8771, config: declaredDefaults, contextLength: 4096, kvCacheType: "f16" });
  expect(args).not.toContain("-ctk");
  expect(args).not.toContain("-ctv");
  expect(args[args.length - 2]).toBe("--cache-reuse");
  expect(args[args.length - 1]).toBe("256");
});

test("a small declared context caps -ub at it", () => {
  const args = llamaServerArgs({ modelPath, port: 8771, config: declaredDefaults, contextLength: 512, kvCacheType: "q8_0" });
  const c = args.indexOf("-c");
  expect(args[c + 1]).toBe("512");
  const ub = args.indexOf("-ub");
  expect(args[ub + 1]).toBe("512");
});

test("the platform default KV cache type matches the launch rule", () => {
  expect(defaultKvCacheType("darwin")).toBe("q8_0");
  expect(defaultKvCacheType("linux")).toBe("f16");
  expect(defaultKvCacheType("win32")).toBe("f16");
});

test("KV cache overrides resolve the rule for every platform", () => {
  expect(kvCacheTypeFor("auto", "darwin")).toBe("q8_0");
  expect(kvCacheTypeFor("auto", "linux")).toBe("f16");
  expect(kvCacheTypeFor("auto", "win32")).toBe("f16");
  expect(kvCacheTypeFor("quantized", "darwin")).toBe("q8_0");
  expect(kvCacheTypeFor("quantized", "linux")).toBe("q8_0");
  expect(kvCacheTypeFor("quantized", "win32")).toBe("q8_0");
  expect(kvCacheTypeFor("full", "darwin")).toBe("f16");
  expect(kvCacheTypeFor("full", "linux")).toBe("f16");
  expect(kvCacheTypeFor("full", "win32")).toBe("f16");
  expect(kvCacheTypeFor(undefined, "darwin")).toBe(defaultKvCacheType("darwin"));
});

test("llama-server args spell q4_0 and omit the default f16 flags", () => {
  const q4 = llamaServerArgs({ modelPath, port: 8771, config: declaredDefaults, contextLength: 4096, kvCacheType: "q4_0" });
  expect(q4.slice(q4.indexOf("-ctk"), q4.indexOf("-ctk") + 4)).toEqual(["-ctk", "q4_0", "-ctv", "q4_0"]);
  const f16 = llamaServerArgs({ modelPath, port: 8771, config: declaredDefaults, contextLength: 4096, kvCacheType: "f16" });
  expect(f16).not.toContain("-ctk");
});
