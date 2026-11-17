import { eq } from "drizzle-orm";
import { StackPartChoices } from "@maipai/spec/stack/ts/stack-part-choices.js";
import type { StackPart } from "@maipai/spec/stack/ts/stack-part.js";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { PART_DEFS, partLabel, type PartDef } from "@/lib/partDefs";
import { stackParts } from "@/lib/parts";

const KEY = "parts.choices";
export type Choices = Record<string, { order: string[]; off: string[] }>;
let requiresOverride: Map<string, string[]> | null = null;
export function __setRequiresForTests(value: Map<string, string[]> | null): void { requiresOverride = value; }
export function readPartChoices(): Choices {
  const value = db.select().from(meta).where(eq(meta.key, KEY)).get()?.value;
  if (!value) return {};
  try { const parsed = StackPartChoices.safeParse(JSON.parse(value)); return parsed.success ? parsed.data : {}; } catch { return {}; }
}
export function writePartChoices(choices: Choices): void {
  const parsed = StackPartChoices.parse(choices);
  db.insert(meta).values({ key: KEY, value: JSON.stringify(parsed) }).onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(parsed) } }).run();
}
export function __resetPartChoicesForTests(): void { db.delete(meta).where(eq(meta.key, KEY)).run(); }
export function enabledFor(id: string, category: string, choices: Choices): boolean { return !(choices[category]?.off ?? []).includes(id); }
export function effectivePriority(def: PartDef, choices: Choices): number {
  const order = choices[def.category]?.order ?? [];
  const index = order.indexOf(def.id);
  return index >= 0 ? index + 1 : order.length + def.priority;
}
function requiredMap(parts: StackPart[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const part of parts) for (const req of requiresOverride?.get(part.id) ?? part.requires) result.set(req, [...(result.get(req) ?? []), part.id]);
  return result;
}
export function choicesRefusal(choices: Choices): { status: 400 | 409; code: string; error: string } | null {
  const definitions = new Map(PART_DEFS.map((def) => [def.id, def]));
  for (const [category, choice] of Object.entries(choices)) {
    for (const id of choice.off) {
      const def = definitions.get(id);
      if (!def || def.category !== category) continue;
      if (def.kind === "engine") return { status: 400, code: "engine_has_no_switch", error: `Engines have no switch: the Stack runs ${def.label} while a part that needs it is on.` };
    }
  }
  const parts = stackParts();
  const requiring = requiredMap(parts);
  for (const [category, choice] of Object.entries(choices)) for (const id of choice.off) {
    const def = definitions.get(id);
    if (!def || def.category !== category) continue;
    const dependents = (requiring.get(id) ?? []).filter((dependent) => {
      const dependentDef = definitions.get(dependent);
      return dependentDef && enabledFor(dependent, dependentDef.category, choices);
    });
    if (dependents.length) return { status: 409, code: "required_by", error: `${def.label} cannot be turned off: ${dependents.map(partLabel).join(", ")} need it. Turn those off first.` };
  }
  return null;
}
