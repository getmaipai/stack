import { expect, test } from "bun:test";
import { roleLines, trayMenuModel, worstHealth } from "@/desktopModel";
import { notify, pickFile, pickFolder } from "@/kit/host";

test("desktop tray model maps health and role lines without Tauri", () => {
  expect(worstHealth(["ok", "warning", "error"])).toBe("error");
  expect(worstHealth(["ok", "critical"])).toBe("critical");
  expect(roleLines([{ label: "Chat", state: "Ready", reason: null }])).toEqual(["Chat: Ready"]);
  expect(trayMenuModel("paused", [{ label: "Chat", state: "Paused" }])).toContain("Resume");
});

test("host adapter keeps browser pickers typed and notifications local", async () => {
  const globals = globalThis as typeof globalThis & { __TAURI__?: unknown };
  const previous = globals.__TAURI__;
  delete globals.__TAURI__;
  try {
    expect(await pickFolder()).toBeNull();
    expect(await pickFile()).toBeNull();
    await notify("Stack", "The browser has no native notification bridge.");
  } finally {
    if (previous === undefined) delete globals.__TAURI__;
    else globals.__TAURI__ = previous;
  }
});
