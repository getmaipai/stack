import { expect, test } from "bun:test";
import { ggufVariants, type HfFile } from "@/lib/hf";

function file(name: string, sizeBytes: number | null): HfFile {
  return { name, sizeBytes, sha256: null, url: `https://huggingface.co/repo/${name}` };
}

test("ggufVariants sums all shards and attaches the projector", () => {
  const result = ggufVariants([
    file("model-Q4_K_M-00001-of-00003.gguf", 10),
    file("model-Q4_K_M-00002-of-00003.gguf", 20),
    file("model-Q4_K_M-00003-of-00003.gguf", 30),
    file("mmproj-F16.gguf", 7),
  ], "owner/repo");
  expect(result).toEqual([{
    id: "model@Q4_K_M", engine: "llama.cpp", sizeBytes: 60, quant: "Q4_K_M",
    files: ["model-Q4_K_M-00001-of-00003.gguf", "model-Q4_K_M-00002-of-00003.gguf", "model-Q4_K_M-00003-of-00003.gguf"],
    projector: "mmproj-F16.gguf", complete: true,
  }]);
});

test("ggufVariants reports incomplete or unknown-size groups with unknown size", () => {
  const result = ggufVariants([
    file("incomplete-Q4_K_M-00001-of-00003.gguf", 10),
    file("incomplete-Q4_K_M-00003-of-00003.gguf", 30),
    file("unknown-Q8_0.gguf", null),
  ], "owner/repo");
  expect(result).toEqual([
    expect.objectContaining({ id: "incomplete@Q4_K_M", sizeBytes: null, complete: false }),
    expect.objectContaining({ id: "unknown@Q8_0", sizeBytes: null, complete: true }),
  ]);
});

test("ggufVariants ignores non-GGUF files and separates quantizations", () => {
  const result = ggufVariants([
    file("model-Q4_K_M.gguf", 40),
    file("model-Q8_0.gguf", 80),
    file("README.md", 1),
  ], "owner/repo");
  expect(result.map(({ id, files }) => ({ id, files }))).toEqual([
    { id: "model@Q4_K_M", files: ["model-Q4_K_M.gguf"] },
    { id: "model@Q8_0", files: ["model-Q8_0.gguf"] },
  ]);
});
