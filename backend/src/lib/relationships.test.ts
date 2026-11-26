import { describe, expect, test } from "bun:test";
import { buildLinks, impactOf, ownerOfFolder, DATA_FOLDERS, type Facts } from "@/lib/relationships";
import { folderImpacts, liveLinks } from "@/lib/relationshipsLive";

const pins = [
  { id: "coder", engine: "splash", companions: ["coder-draft"], imageInput: { projector: "coder-mmproj" } },
  { id: "chat", engine: "llama-server", superseded_by: ["chat2"] },
];
const make = (installed: string[], inUse: string[] = [], extra: Partial<Facts> = {}): Facts => ({
  pins, loras: [{ id: "lora.x", base_model: "ltx" }], loraBases: { ltx: "chat" }, installed: (id) => installed.includes(id), inUse: (id) => inUse.includes(id), ...extra,
});

describe("relationship map", () => {
  test("links come from the rows: engine, draft, vision, replaced, style; extenders run on the base's engine", () => {
    const links = buildLinks(make([]));
    const has = (from: string, kind: string, to: string) => links.some((l) => l.from === from && l.kind === kind && l.to === to);
    expect(has("coder", "driven_by", "splash")).toBe(true);
    expect(has("coder", "draft", "coder-draft")).toBe(true);
    expect(has("coder", "vision", "coder-mmproj")).toBe(true);
    expect(has("coder-draft", "driven_by", "splash")).toBe(true);
    expect(has("chat", "replaced_by", "chat2")).toBe(true);
    expect(has("lora.x", "style", "chat")).toBe(true);
  });
  test("deleting an engine is blocked while an installed model in use runs on it, and only warns when it is idle", () => {
    expect(impactOf(make(["coder"], ["coder"]), "splash", "delete").blocking.map((n) => n.id)).toEqual(["coder", "coder-draft"].filter((id) => id === "coder"));
    const idle = impactOf(make(["coder"]), "splash", "delete");
    expect(idle.blocking).toEqual([]); expect(idle.warnings.map((n) => n.id)).toContain("coder");
    expect(impactOf(make([]), "splash", "delete")).toMatchObject({ blocking: [], warnings: [] });
  });
  test("deleting a draft or vision add-on of a model in use is blocked", () => {
    expect(impactOf(make(["coder", "coder-draft"], ["coder"]), "coder-draft", "delete").blocking.map((n) => n.id)).toEqual(["coder"]);
    expect(impactOf(make(["coder", "coder-mmproj"], ["coder"]), "coder-mmproj", "delete").blocking[0]?.why).toContain("vision add-on");
  });
  test("deleting or moving a base model names the extenders that go with it or stay behind", () => {
    const facts = make(["coder", "coder-draft", "coder-mmproj"]);
    expect(impactOf(facts, "coder", "delete").warnings.map((n) => n.id).sort()).toEqual(["coder-draft", "coder-mmproj"]);
    expect(impactOf(facts, "coder", "move").warnings[0]?.why).toContain("stays where it is");
  });
  test("a hub-layout model cannot be moved alone (the lost-files case)", () => {
    const impact = impactOf(make(["coder"], [], { hubLayout: (id) => id === "coder" }), "coder", "move");
    expect(impact.blocking[0]?.why).toContain("hub layout");
    expect(impactOf(make(["coder"]), "coder", "move").blocking).toEqual([]);
  });
  test("upgrading an engine warns about the models restarted on it; deleting a base warns about styles", () => {
    expect(impactOf(make(["chat"]), "llama-server", "upgrade").warnings.map((n) => n.id)).toEqual(["chat"]);
    expect(impactOf({ ...make(["chat", "lora.x"]) }, "chat", "delete").warnings.map((n) => n.id)).toContain("lora.x");
  });
  test("data/splash belongs to the Splash engine, and an unknown folder has no owner", () => {
    expect(ownerOfFolder("splash/hub/models--x")?.owner).toEqual({ kind: "engine", id: "splash" });
    expect(ownerOfFolder("nothing-like-this")).toBeNull();
    expect(new Set(DATA_FOLDERS.map((r) => r.path)).size).toBe(DATA_FOLDERS.length);
  });
  test("the folder report labels splash as the engine's, names who runs on it, and flags unknown folders", () => {
    const list = () => ["splash", "mystery", "models"];
    const rows = folderImpacts(make(["coder"], ["coder"]), list, () => 19);
    const splash = rows.find((r) => r.path === "splash")!;
    expect(splash.owner).toEqual({ kind: "engine", id: "splash" }); expect(splash.in_use).toBe(true); expect(splash.used_by.map((u) => u.id)).toContain("coder");
    expect(splash.advice).toContain("not this folder");
    expect(rows.find((r) => r.path === "mystery")).toMatchObject({ owner: null, in_use: false });
    const idle = folderImpacts(make([]), () => ["splash"], () => 1)[0]!;
    expect(idle.in_use).toBe(false); expect(idle.advice).toContain("no installed model runs on it");
  });
  test("the real catalog yields splash-driven models with drafts, so the map matches the code", () => {
    const links = liveLinks();
    expect(links.some((l) => l.kind === "driven_by" && l.to === "splash")).toBe(true);
    expect(links.some((l) => l.kind === "draft")).toBe(true);
    expect(links.some((l) => l.kind === "vision")).toBe(true);
  });
});
