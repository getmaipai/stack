import { afterEach, expect, test } from "bun:test";
import { Image, Sparkles } from "lucide-react";
import { featureOrder, setFeatureRows } from "./featureRows";
import { roleIcon } from "./roleIcons";

afterEach(() => setFeatureRows([]));

test("an icon comes from the Stack's row, and the order is the Stack's order", () => {
  setFeatureRows([{ role: "chat", icon: "sparkles" }, { role: "image", icon: "image" }]);
  expect(roleIcon("chat")).toBe(Sparkles);
  expect(roleIcon("image")).toBe(Image);
  expect(featureOrder()).toEqual(["chat", "image"]);
});
test("a row's icon wins over the fallback table", () => {
  setFeatureRows([{ role: "chat", icon: "image" }]);
  expect(roleIcon("chat")).toBe(Image);
});
test("before the rows load, a feature still gets an icon", () => {
  setFeatureRows([]);
  expect(roleIcon("chat")).toBe(Sparkles);
});
