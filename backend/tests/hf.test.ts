import { afterEach, expect, test } from "bun:test";
import { hfUrl, huggingFaceEndpoint } from "@/lib/hf";
import { __resetStackSettingsForTests, updateStackConfig } from "@/settings/stackKeys";

afterEach(() => { __resetStackSettingsForTests(); });

test("hfUrl builds URLs from the default Hugging Face endpoint", () => {
  expect(huggingFaceEndpoint()).toBe("https://huggingface.co");
  expect(hfUrl("Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf")).toBe("https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf");
  expect(hfUrl("api/models?search=gguf")).toBe("https://huggingface.co/api/models?search=gguf");
});

test("hfUrl follows the Hugging Face endpoint setting, with a trailing slash allowed", () => {
  updateStackConfig({ huggingFaceEndpoint: "https://hf.internal/" });
  expect(huggingFaceEndpoint()).toBe("https://hf.internal");
  expect(hfUrl("/Qwen/Qwen3-8B-GGUF/resolve/7c41481f/chat.gguf")).toBe("https://hf.internal/Qwen/Qwen3-8B-GGUF/resolve/7c41481f/chat.gguf");
});
