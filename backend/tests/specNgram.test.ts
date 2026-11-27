import { expect, test } from "bun:test";
import { llamaServerArgs } from "@/lib/engineArgs";
import { SETTINGS } from "@/settings";

const base = { modelPath: "/models/m.gguf", port: 8771, contextLength: 8192, kvCacheType: "q8_0" as const };
const flag = (args: string[]) => { const i = args.indexOf("--spec-type"); return i < 0 ? null : args[i + 1]; };

test("n-gram speculative decoding is off by default and off for an unknown value", () => {
  expect(SETTINGS.find((d) => d.key === "stack.engines.llama_server.speculative_ngram")?.default).toBe("off");
  expect(flag(llamaServerArgs({ ...base, config: {} }))).toBeNull();
  expect(flag(llamaServerArgs({ ...base, config: { speculativeNgram: "off" } }))).toBeNull();
  expect(flag(llamaServerArgs({ ...base, config: { speculativeNgram: "bogus" } }))).toBeNull();
});

test("chat gets the chosen n-gram type; pictures, embed and rerank never do", () => {
  expect(flag(llamaServerArgs({ ...base, config: { speculativeNgram: "simple" } }))).toBe("ngram-simple");
  expect(flag(llamaServerArgs({ ...base, config: { speculativeNgram: "mod" } }))).toBe("ngram-mod");
  expect(flag(llamaServerArgs({ ...base, config: { speculativeNgram: "mod" }, projectorPath: "/m/mmproj.gguf" }))).toBeNull();
  expect(flag(llamaServerArgs({ ...base, config: { speculativeNgram: "mod" }, onePictureSlot: true }))).toBeNull();
  expect(flag(llamaServerArgs({ ...base, config: { speculativeNgram: "mod" }, embeddings: true }))).toBeNull();
  expect(flag(llamaServerArgs({ ...base, config: { speculativeNgram: "mod" }, reranking: true }))).toBeNull();
});
