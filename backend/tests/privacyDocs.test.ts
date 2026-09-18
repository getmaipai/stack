import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the privacy page says model downloads go to Hugging Face or the chosen mirror", () => {
  const page = readFileSync(join(import.meta.dir, "../../docs/user/privacy.md"), "utf8");
  expect(page).toContain("| Downloading a model or an engine | Only when you pick one to install, or accept an update | The name of the file you asked for | Hugging Face, or the mirror you chose in Settings, straight from your computer |");
});
