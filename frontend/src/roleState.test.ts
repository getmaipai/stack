import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { roleState, type RoleRecord } from "@/lib/api";

// STACK-87: GET /stack/v1/roles started returning `state` as the stamped
// { state, since, checkedAt?, reason? } record instead of a bare string
// (backend/src/roles.ts's RoleStateRecordSchema). Every reader that still
// compared `role.state` to a string literal silently broke: React #31 in
// BoardPage's Badge, "0 running" in the footer counts, every role
// registering as not-ready in TryItPage. `roleState()` is the one place
// that unwraps it; this fixture matches the real generated OpenAPI shape
// (docs/api/openapi.json, GET /stack/v1/roles) so a future drift here
// shows up as a type error, not a silent runtime one.
const readyChat: RoleRecord = {
  id: "chat",
  label: "Chat",
  wire: "chat",
  residency: "resident",
  endpoints: ["/v1/chat/completions"],
  quality: ["fast", "everyday", "best"],
  description: "Talk with your local AI.",
  state: { state: "ready", since: "2026-09-18T00:00:00.000Z", checkedAt: "2026-09-20T00:00:00.000Z" },
  reason: null,
  model: { id: "qwen3-27b-instruct", sizeBytes: 17_200_000_000, measuredFootprintBytes: 21_600_000_000, measuredContextLength: 8192, estimated: false },
};

test("roleState unwraps the stamped record to its plain state string", () => {
  expect(roleState(readyChat)).toBe("ready");
  expect(roleState({ ...readyChat, state: { state: "offline", since: "2026-09-18T00:00:00.000Z", reason: "The chat engine is waiting for its first install." } })).toBe("offline");
});

// A grep guard, not a type checker: every file that imports RoleRecord is
// scanned for a direct `<something>.state === "<a real RoleState value>"`
// comparison, the exact shape of the STACK-87 bug. `.store.`/`.engine.`
// lines are excluded because DetectedRecord and EngineRecord carry their
// own, differently-shaped `state` fields that legitimately share some of
// the same string values (e.g. "offline"). A real hit here means a new
// consumer forgot to route through `roleState()`.
test("no file outside lib/api.ts compares a role's raw .state to a string literal", () => {
  const root = join(import.meta.dir);
  const files: string[] = [];
  (function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  })(root);

  const stateLiteral = /\.state\s*(===|!==)\s*"(notInstalled|installed|loaded|ready|offline)"/;
  const offenders: string[] = [];
  for (const file of files) {
    if (file.endsWith("/lib/api.ts") || file.endsWith("roleState.test.ts")) continue;
    const content = readFileSync(file, "utf8");
    if (!content.includes("RoleRecord")) continue;
    for (const line of content.split("\n")) {
      if (line.includes(".store.") || line.includes(".engine.") || line.includes("store.state") || line.includes("engine.state")) continue;
      if (stateLiteral.test(line)) offenders.push(`${file}: ${line.trim()}`);
    }
  }
  expect(offenders).toEqual([]);
});
