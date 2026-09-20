import { expect, test } from "bun:test";
import { collectComponentsCatalog, renderComponentsDoc, type ComponentsCatalog } from "@/lib/componentsDoc";
import { PROFILE_TIERS } from "@/profiles";

const scripted: ComponentsCatalog = {
  roles: ["chat", "judge", "tts", "image"],
  labels: { chat: "Chat", judge: "Judge", tts: "Voice out", image: "Images" },
  shares: { judge: "chat" },
  engines: [{ id: "llama-server-b10797-macos-arm64", name: "llama-server", tag: "b10797", platform: "darwin", arch: "arm64", requiresNvidia: false, label: "llama-server", archive: { label: "x", url: "https://github.com/x", sha256: "a".repeat(64), approxBytes: 1 }, verified: true }],
  profiles: PROFILE_TIERS,
  // Declared biggest-first on purpose: the row must pick by profile and
  // size, never by array order.
  models: [{ id: "chat-big", role: "chat", repo: "org/big", license: "MIT", revision: "r2", sizing: { profile: "p64", quantization: "Q4_K_M" }, download: { url: "https://huggingface.co/y", sha256: "b".repeat(64), approx_bytes: 4 * 1_073_741_824 } }, { id: "chat-small", role: "chat", repo: "org/small", license: "MIT", revision: "r1", sizing: { profile: "p16", quantization: "Q8_0" }, download: { url: "https://huggingface.co/x", sha256: "a".repeat(64), approx_bytes: 1_073_741_824 }, measured: { footprintBytes: 2 * 1_073_741_824, contextLength: 4096, hardware: "an Apple silicon Mac, 16 GB" } }, { id: "chat-typo", role: "chat", license: "MIT", revision: "r3", sizing: { profile: "p-32" }, download: { url: "https://huggingface.co/z", sha256: "c".repeat(64), approx_bytes: 9 * 1_073_741_824 } }],
  candidates: { chat: [{ name: "mlx-serve", kind: "engine", source: "STACK-93" }], tts: [{ name: "the chosen TTS runtime", kind: "engine", source: "STACK-94" }], image: [{ name: "ComfyUI (managed)", kind: "engine", source: "STACK-13" }] },
};

test("one section per role in order, one row per profile, the largest fitting pin wins", () => {
  const doc = renderComponentsDoc(scripted);
  const sections = [...doc.matchAll(/^## (\S+)/gm)].map((match) => match[1]);
  expect(sections).toEqual(["chat", "judge", "tts", "image"]);
  for (const role of scripted.roles) {
    const section = doc.split(`## ${role} `)[1]!.split("\n## ")[0]!;
    for (const profile of ["p16", "p32", "p64", "p128"]) expect(section).toContain(`| ${profile} |`);
  }
  const chat = doc.split("## chat ")[1]!.split("\n## ")[0]!;
  expect(chat).toContain("| p16 | resident | `chat-small` | Q8_0 | 1.00 GB | 2.00 GB (an Apple silicon Mac, 16 GB) | 4096 | MIT | org/small @ r1 | pinned |");
  expect(chat).toContain("| p64 | resident | `chat-big` | Q4_K_M | 4.00 GB | not measured | not measured | MIT | org/big @ r2 | pinned |");
  // A pin whose sizing.profile is not a tier needs the largest tier, and even there the biggest real pin wins by profile before size.
  expect(chat).toContain("| p128 | resident | `chat-typo` |");
  expect(chat).not.toContain("| p32 | resident | `chat-typo` |");
  expect(chat).toContain("| `llama-server-b10797-macos-arm64` | b10797 | darwin arm64 | pinned, verified |");
});

test("a shared role shows the role it shares; a role with candidates says so; a role with nothing says not yet", () => {
  const doc = renderComponentsDoc(scripted);
  expect(doc.split("## judge ")[1]!).toContain("Shares `chat`'s model");
  expect(doc.split("## judge ")[1]!.split("\n## ")[0]!).toContain("| mlx-serve | | | candidate (STACK-93) |");
  expect(doc.split("## image ")[1]!).toContain("| p16 | not available |  |  |  |  |  |  |  | not available |");
  expect(doc.split("## tts ")[1]!.split("\n## ")[0]!).toContain("| the chosen TTS runtime | | | candidate (STACK-94) |");
  expect(doc.split("## tts ")[1]!.split("\n## ")[0]!).toContain("| p16 | resident |  |  |  |  |  |  |  | not yet |");
  expect(doc.split("## image ")[1]!).toContain("| p128 | on demand |  |  |  |  |  |  |  | not yet |");
});

test("the real catalog renders every declared role with the shipped chat pin", () => {
  const doc = renderComponentsDoc(collectComponentsCatalog());
  expect([...doc.matchAll(/^## (\S+)/gm)]).toHaveLength(13);
  expect(doc).toContain("`qwen3-1.7b-q8-0`");
  expect(doc.startsWith("<!-- GENERATED")).toBe(true);
});
