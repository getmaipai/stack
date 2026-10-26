import { describe, expect, test } from "bun:test";
import { describeStartFailure, stderrEvidence } from "../src/lib/crashClassifier";

// The 2026-10-26 llama-server stderr: the Metal compiler error comes early, then
// more than five lines of ordinary output, then the generic last line the Stack kept.
const METAL_2026_10_26 = [
  "ggml_metal_device_init: GPU name:   Apple M3 Ultra",
  "ggml_metal_library_compile_all: failed to build library: Error Domain=MTLLibraryErrorDomain Code=3",
  "ggml_metal_library_compile_all: Unable to reach MTLCompilerService",
  "E ggml_metal_init: error: failed to initialize the Metal library",
  ...Array.from({ length: 12 }, (_, i) => `load_tensors: layer ${i} assigned to device CPU`),
  "llama_context: n_ctx = 32768",
  "llama_init_from_model: failed to initialize the context",
  "common_init_from_params: failed to create context with model '/models/chat.gguf'",
  "srv    load_model: failed to load model, '/models/chat.gguf'",
  "main: exiting due to model loading error",
].join("\n");

describe("start failure reason", () => {
  test("Metal compiler unreachable becomes one plain sentence", () => {
    const reason = describeStartFailure(1, METAL_2026_10_26);
    expect(reason).toStartWith("The Mac's graphics compiler is not responding. Restart the Mac, then chat starts again on its own.");
    expect(reason).not.toContain("failed to create context");
  });

  test("an unknown cause keeps the first error lines and the tail, bounded", () => {
    const log = ["E first thing broke", "info a", "info b", "info c", "info d", "info e", "info f", "last line"].join("\n");
    const reason = describeStartFailure(3, log);
    expect(reason).toStartWith("Engine exited before becoming healthy (code 3): ");
    expect(reason).toContain("E first thing broke");
    expect(reason).toContain("last line");
    expect(describeStartFailure(3, "x".repeat(50_000)).length).toBeLessThan(1_500);
  });

  test("a short unknown log reads as before", () => {
    expect(describeStartFailure(3, "cannot start: the model could not be assembled")).toBe("Engine exited before becoming healthy (code 3): cannot start: the model could not be assembled");
    expect(describeStartFailure(3, "")).toBe("Engine exited before becoming healthy (code 3).");
  });

  test("out of memory is named when the log shows it", () => {
    expect(describeStartFailure(1, "ggml_backend_metal_buffer_type_alloc_buffer: failed to allocate buffer of size 9000000000")).toContain("ran out of memory");
  });

  test("the log event carries the first errors and the tail", () => {
    const ev = stderrEvidence(METAL_2026_10_26);
    expect(ev.some((l) => l.includes("MTLCompilerService"))).toBe(true);
    expect(ev.at(-1)).toBe("main: exiting due to model loading error");
    expect(ev.length).toBeLessThanOrEqual(30);
  });
});
