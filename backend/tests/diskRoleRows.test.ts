import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildDiskPlan } from "@/lib/diskPlan";
import { partDef } from "@/lib/partDefs";
import { PROFILE_TIERS } from "@/profiles";
import roleRows from "@/rows/diskRoleRows.json";

// p128 is the tier that plans all five plain roles (vision, judge, coding, embed, stt).
const tier = PROFILE_TIERS.find((candidate) => candidate.id === "p128")!;
const plan = buildDiskPlan(tier);

test("the plain-role rows appear in order with the same needs as before", () => {
  const ids = plan.rows.map((row) => row.id);
  const start = ids.indexOf("vision");
  expect(start).toBeGreaterThan(-1);
  expect(ids.slice(start, start + 5)).toEqual(["vision", "judge", "coding", "embed", "stt"]);
  const need = (id: string) => plan.rows.find((row) => row.id === id)!.need;
  expect(need("vision")).toBe("recommended");
  expect(need("judge")).toBe("required");
  expect(need("coding")).toBe("recommended");
  expect(need("embed")).toBe("required");
  expect(need("stt")).toBe("required");
});

test("each row's label and note come from its part, except the judge's fixed note", () => {
  for (const entry of roleRows) {
    const row = plan.rows.find((candidate) => candidate.id === entry.id)!;
    expect(row.note).toBe(entry.note ?? partDef(entry.part)!.description);
  }
  expect(plan.rows.find((row) => row.id === "judge")!.note).toBe("A second, smaller AI that double-checks answers.");
});

test("diskPlan.ts no longer filters pins by the vision role by hand", () => {
  const source = readFileSync(new URL("../src/lib/diskPlan.ts", import.meta.url), "utf8");
  expect(source.includes('pin.role === "vision"')).toBe(false);
});
