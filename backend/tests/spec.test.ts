// Round-trips every fixture under src/spec/fixtures/ through both its
// JSON Schema (Ajv 2020, as catalog/tools/src/lint.ts validates
// manifests) and its hand-written Zod mirror, and requires the two to
// agree with the fixture's own name (valid-*, invalid-*). This is the
// TS half of home/spec's fixture proof, applied to the Stack's wire
// shapes until they move to shared/spec and the Zod is generated.
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";
import { RoleRequest } from "@/spec/ts/role-request";
import { RoleReplyHeaders } from "@/spec/ts/role-reply-headers";
import { StackEvent } from "@/spec/ts/stack-event";
import { HealthItem } from "@/spec/ts/health-item";
import { StackSetting } from "@/spec/ts/stack-setting";
import { PreciousState } from "@/spec/ts/precious-state";

const SPEC = join(import.meta.dir, "..", "src", "spec");
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

const SHAPES: Array<{ name: string; zod: ZodType }> = [
  { name: "role-request", zod: RoleRequest },
  { name: "role-reply-headers", zod: RoleReplyHeaders },
  { name: "stack-event", zod: StackEvent },
  { name: "health-item", zod: HealthItem },
  { name: "stack-setting", zod: StackSetting },
  { name: "precious-state", zod: PreciousState },
];

for (const shape of SHAPES) {
  describe(shape.name, () => {
    const schema = JSON.parse(readFileSync(join(SPEC, "schemas", `${shape.name}.schema.json`), "utf8")) as { $id: string; $schema: string };
    const validate = ajv.compile(schema);
    const fixtures = readdirSync(join(SPEC, "fixtures", shape.name)).filter((entry) => entry.endsWith(".json")).sort();

    test("declares its $id under shared/spec and has a valid and an invalid fixture", () => {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.$id).toBe(`https://getmaipai.github.io/shared/spec/schemas/${shape.name}.schema.json`);
      expect(fixtures.some((entry) => entry.startsWith("valid-"))).toBe(true);
      expect(fixtures.some((entry) => entry.startsWith("invalid-"))).toBe(true);
    });

    for (const fixture of fixtures) {
      const expected = fixture.startsWith("valid") ? "accept" : "refuse";
      test(`${fixture}: the schema and the Zod mirror both ${expected}`, () => {
        const value = JSON.parse(readFileSync(join(SPEC, "fixtures", shape.name, fixture), "utf8")) as unknown;
        const bySchema = validate(value);
        const byZod = shape.zod.safeParse(value).success;
        expect(bySchema, `JSON Schema: ${ajv.errorsText(validate.errors)}`).toBe(expected === "accept");
        expect(byZod, "Zod mirror").toBe(expected === "accept");
      });
    }
  });
}
