import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the privacy page declares Hugging Face discovery and model downloads", () => {
  const page = readFileSync(join(import.meta.dir, "../../docs/user/privacy.md"), "utf8");
  expect(page).toContain("| Searching or inspecting Hugging Face from Add | Only when you switch on Search Hugging Face in Settings and choose Search or Choose in the Add sheet | A `GET` with the search text or selected repository name, then its immutable revision and file list | `huggingface.co`, for model discovery only |");
  expect(page).toContain("| Downloading a model or an engine | Only when you pick one to install, or accept an update | The name of the file you asked for | Hugging Face, or the mirror you chose in Settings, straight from your computer |");
});
