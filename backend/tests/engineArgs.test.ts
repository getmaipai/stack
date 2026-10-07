import { expect, test } from "bun:test";
import { defaultKvCacheType, kvCacheTypeFor, llamaServerArgs, mlxKvQuantFor, mlxServeArgs } from "@/lib/engineArgs";

const modelPath = "/models/chat.gguf";
const declaredDefaults: Record<string, number | boolean | string> = {
  contextLength: 4096,
  slots: 1,
  threads: 0,
  cacheRamMb: 0,
  flashAttention: true,
};

test("MLX KV quant follows the override", () => {
  expect(mlxKvQuantFor("quantized")).toBe(8);
  expect(mlxKvQuantFor("auto")).toBeNull();
  expect(mlxKvQuantFor("full")).toBeNull();
  expect(mlxKvQuantFor(undefined)).toBeNull();
});

test("MLX serve args append KV quant only when selected", () => {
  const port = 8770 + 1;
  const contextLength = 2048 * 2;
  const slots = 0 + 1;
  const options = { modelPath, port, contextLength, slots, prefixCacheFlag: "1024MB" };
  const base = ["--model", modelPath, "--serve", "--host", "127.0.0.1", "--port", String(port), "--ctx-size", String(contextLength), "--max-concurrent", String(slots), "--prefix-cache-mem", "1024MB"];
  expect(mlxServeArgs({ ...options, kvQuant: null })).toEqual(base);
  expect(mlxServeArgs({ ...options, kvQuant: 8 })).toEqual([...base, "--kv-quant", "8"]);
  expect(mlxServeArgs(options)).toEqual(mlxServeArgs({ ...options, kvQuant: null }));
});

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

test("llama-server does not enable request logging or slot saves by default", () => {
  const args = llamaServerArgs({ modelPath, port: 8771, config: declaredDefaults, contextLength: 4096, kvCacheType: "q8_0" });
  expect(args).not.toContain("--slot-save-path");
  expect(args).not.toContain("--slot-save");
  expect(args).not.toContain("--log-file");
  expect(args).not.toContain("--log-verbosity");
  expect(args).not.toContain("--verbose");
  expect(args).toContain("--cache-reuse");
  expect(args).not.toContain("--cache_prompt");
  expect(args).not.toContain("--cache-prompt");
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

test("a vision launch loads its projector with one slot and no cache reuse (VISION-01b)", () => {
  const args = llamaServerArgs({ modelPath: "/models/vision.gguf", port: 8772, config: { ...declaredDefaults, slots: 4 }, contextLength: 8192, kvCacheType: "q8_0", projectorPath: "/models/mmproj.gguf", onePictureSlot: true });
  const mmproj = args.indexOf("--mmproj");
  expect(args[mmproj + 1]).toBe("/models/mmproj.gguf");
  expect(args.slice(args.indexOf("--parallel"), args.indexOf("--parallel") + 2)).toEqual(["--parallel", "1"]);
  expect(args.filter((arg) => arg === "--parallel")).toHaveLength(1);
  expect(args).not.toContain("--cache-reuse");
  expect(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2)).toEqual(["-c", "8192"]);
});

test("a text launch never names a projector (VISION-01b)", () => {
  expect(llamaServerArgs({ modelPath, port: 8771, config: declaredDefaults, contextLength: 4096, kvCacheType: "q8_0" })).not.toContain("--mmproj");
});
