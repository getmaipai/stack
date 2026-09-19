import { expect, mock, test } from "bun:test";
import { getIcon } from "@/kit/icons";

test("getIcon returns Box and warns for an unknown icon", () => {
  const warn = mock(() => undefined);
  const originalWarn = console.warn;
  console.warn = warn;
  try {
    expect(getIcon("NotAnIcon")).toBe(getIcon("Box"));
    expect(warn).toHaveBeenCalledWith("Unknown icon: NotAnIcon");
  } finally {
    console.warn = originalWarn;
  }
});
