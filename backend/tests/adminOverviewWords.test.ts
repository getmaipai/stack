// The Overview's grouping and one-line wording (admin-ui/src/roleWords.ts): only a broken feature is red, and each line says what to do.
import { expect, test } from "bun:test";
import { roleGroup, roleLine } from "../../admin-ui/src/roleWords";
import type { Role } from "../../admin-ui/src/api";

const role = (state: Role["state"]["state"], extra: Partial<Role> = {}): Role => ({ id: "chat", label: "Chat", state: { state, since: "2026-11-21T12:00:00Z" }, ...extra });

test("a feature that is off or not set up is calm, only a broken one is red", () => {
  expect(roleGroup(role("notInstalled"))).toBe("off");
  expect(roleGroup(role("ready", { enabled: false }))).toBe("off");
  expect(roleGroup(role("ready"))).toBe("working");
  expect(roleGroup(role("installed"))).toBe("working");
  expect(roleGroup(role("offline"))).toBe("broken");
});

test("each line is plain words and a broken feature says where to look", () => {
  expect(roleLine(role("notInstalled"))).toBe("Not set up yet");
  expect(roleLine(role("ready", { enabled: false }))).toBe("Turned off");
  expect(roleLine(role("ready", { model: { id: "m1", sizeBytes: null, measuredFootprintBytes: null } }))).toBe("Answering with m1");
  expect(roleLine(role("offline"))).toContain("Tap for the reason");
  expect(roleLine(role("offline"), true)).toBe("Not answering");
});
