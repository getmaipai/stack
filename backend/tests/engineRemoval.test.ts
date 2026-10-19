import { expect, test } from "bun:test";
import { engineRemovalRefusal } from "@/lib/engineRemoval";

test("current build with role running is refused", () => {
  expect(
    engineRemovalRefusal({ isCurrent: true, hasCurrent: true, roleRunning: true, bound: false }),
  ).toBe("This engine build is serving a role right now. Stop the role first, then remove the build.");
});

test("bound build with no current build is refused", () => {
  expect(
    engineRemovalRefusal({ isCurrent: false, hasCurrent: false, roleRunning: false, bound: true }),
  ).toBe("A model still names this engine. Install or select another build first.");
});

test("current build with role stopped is allowed", () => {
  expect(
    engineRemovalRefusal({ isCurrent: true, hasCurrent: true, roleRunning: false, bound: false }),
  ).toBeNull();
});

test("non-current bound build while a current build exists is allowed", () => {
  expect(
    engineRemovalRefusal({ isCurrent: false, hasCurrent: true, roleRunning: false, bound: true }),
  ).toBeNull();
});

test("non-current unbound build with role running is allowed", () => {
  expect(
    engineRemovalRefusal({ isCurrent: false, hasCurrent: true, roleRunning: true, bound: false }),
  ).toBeNull();
});
