// The Helper reads a message before the model does (lib/helperInterpret.ts, lib/helperKnowledge.ts): which
// words are tiers, engines and features, which typed action a command means, and when to ask instead of guess.
// Pure: no model, no network.
import { expect, test } from "bun:test";
import { gb, interpretationHint, plainJson, resolveRole, termsIn, topicFromCalls } from "@/lib/helperKnowledge";
import { interpret } from "@/lib/helperInterpret";

const act = (m: string, previous = null as Parameters<typeof interpret>[1]) => interpret(m, previous).action;

test("bytes become GB, in one place", () => {
  expect(gb(25_062_267_288)).toBe("25.1 GB");
  expect(gb(137_438_953_472)).toBe("137 GB");
  expect(gb(10)).toBe("under 0.1 GB");
  expect(plainJson({ free_bytes: 3_300_000_000, nested: { total_bytes: 2_000_000_000, name: "x" } })).toEqual({ free_gb: "3.3 GB", nested: { total_gb: "2 GB", name: "x" } });
});

test("feature words: ids, labels, everyday words, and the two that fit two features", () => {
  expect(resolveRole("video")).toEqual({ ok: true, role: "video" });
  expect(resolveRole("Voice out")).toEqual({ ok: true, role: "tts" });
  expect(resolveRole("pictures")).toEqual({ ok: true, role: "image" });
  expect(resolveRole("image generation")).toEqual({ ok: true, role: "image" });
  const speech = resolveRole("speech");
  expect(speech.ok).toBe(false);
  expect(!speech.ok && speech.options).toEqual(["stt", "tts"]);
  expect(!speech.ok && speech.reason).toContain("Voice in");
  expect(resolveRole("banana").ok).toBe(false);
});

test("tier, engine and feature words are told apart; Splash is an engine and Coding is a feature", () => {
  expect(termsIn("what about max")).toEqual({ tier: "max" });
  expect(termsIn("why is splash taking so much memory")).toEqual({ engine: "splash" });
  expect(termsIn("what are my coding models")).toEqual({ role: "coding" });
  expect(termsIn("max tier for pictures")).toEqual({ tier: "max", role: "image" });
  expect(interpretationHint("what about max", { role: "coding" })).toContain('"max" is a TIER name');
  expect(interpretationHint("what about max", { role: "coding" })).toContain("feature coding");
  expect(interpretationHint("why is splash big", null)).toContain('"splash" is an ENGINE name');
  expect(topicFromCalls([{ name: "get_models", args: { role: "coding", tier: "max" } }], "what about max")).toEqual({ tier: "max", role: "coding" });
});

test("clear commands become one typed action", () => {
  expect(act("turn video off")).toEqual({ action: "set_role_enabled", params: { role: "video", enabled: false } });
  expect(act("Please turn the music on")).toEqual({ action: "set_role_enabled", params: { role: "music", enabled: true } });
  expect(act("turn off images")).toEqual({ action: "set_role_enabled", params: { role: "image", enabled: false } });
  expect(act("could you switch the video feature off for me")).toEqual({ action: "set_role_enabled", params: { role: "video", enabled: false } });
  expect(act("disable music")).toEqual({ action: "set_role_enabled", params: { role: "music", enabled: false } });
  expect(act("move music above voice out")).toEqual({ action: "set_role_priority", params: { role: "music", above: "tts" } });
  expect(act("put video after chat")).toEqual({ action: "set_role_priority", params: { role: "video", below: "chat" } });
  expect(act("set the coding priority to 5")).toEqual({ action: "set_role_priority", params: { role: "coding", priority: 5 } });
  expect(act("apply the recommended profile")).toEqual({ action: "apply_profile", params: { mode: "custom_recommended" } });
  expect(act("restart the stack")).toEqual({ action: "restart_stack", params: {} });
  expect(act("restart the voice out engine")).toEqual({ action: "restart_engine", params: { name: "voice out" } });
  expect(act("restart llama-server")).toEqual({ action: "restart_engine", params: { name: "llama-server" } });
  expect(act("check for updates")).toEqual({ action: "check_updates", params: {} });
});

test("a pronoun leans on the feature talked about before; with nothing before it, the Helper asks", () => {
  expect(act("turn it off", { role: "video" })).toEqual({ action: "set_role_enabled", params: { role: "video", enabled: false } });
  expect(interpret("turn it off", null).say).toContain("Which feature");
  expect(interpret("turn off", null).say).toContain("Which feature");
});

test("words that fit two features become a question, never a guess", () => {
  for (const m of ["move music above speech", "restart the speech engine", "turn on the voice", "set voice priority to 3"]) {
    const plan = interpret(m, null);
    expect(plan.action).toBeUndefined();
    expect(plan.say).toMatch(/Voice in.*Voice out/);
    expect(plan.say).toContain("?");
  }
});

test("what is not offered gets a fixed answer that points to the right screen", () => {
  expect(interpret("reboot the computer", null).say).toContain("Tools screen");
  expect(interpret("shut down the pc", null).say).toContain("Tools screen");
  expect(interpret("delete the coding model", null).say).toContain("AI and models screen");
  expect(interpret("uninstall the 27b model", null).say).toContain("AI and models screen");
  expect(interpret("what is my admin password", null).say).toContain("cannot");
  // restart llama-server is an engine, not the computer.
  expect(interpret("restart llama-server", null).say).toBeUndefined();
});

test("questions run the reads that answer them first", () => {
  const reads = (m: string, previous = null as Parameters<typeof interpret>[1]) => interpret(m, previous).reads.map((r) => `${r.name} ${JSON.stringify(r.args)}`);
  expect(reads("why is splash taking so much memoru")).toEqual(['get_engine_use {"name":"splash"}']);
  expect(reads("what are my coding models")).toEqual(['get_models {"role":"coding"}']);
  expect(reads("what about max", { role: "coding" })).toEqual(['get_models {"role":"coding","tier":"max"}']);
  expect(reads("and for pictures?", { role: "coding" })).toEqual(['get_models {"role":"image"}']);
  expect(reads("what is splash")).toEqual(['explain {"term":"splash"}']);
  expect(reads("what is the max tier")).toEqual(['explain {"term":"max"}']);
  expect(reads("what is the max tier for pictures")).toEqual(['get_models {"role":"image","tier":"max"}']);
  expect(reads("what is the difference between a role, an engine and a model")).toEqual(['explain {"term":"role"}', 'explain {"term":"engine"}', 'explain {"term":"model"}']);
  expect(reads("is everything healthy?")).toEqual(["get_health {}"]);
  expect(reads("how much memory is free?")).toEqual(["get_memory {}"]);
  expect(reads("how much memory does this computer have")).toEqual(["get_hardware {}"]);
  expect(reads("which features are on")).toEqual(['get_roles {"focus":"onoff"}']);
  expect(reads("is video turned on")).toEqual(["get_roles {}"]);
  expect(reads("what is the priority of music")).toEqual(["get_roles {}"]);
  expect(reads("what does reduced mean")).toEqual(['explain {"term":"reduced"}']);
  // A message the rules do not recognise is left to the model and its tools.
  expect(reads("tell me a joke")).toEqual([]);
});
