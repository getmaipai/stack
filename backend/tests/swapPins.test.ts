import { expect, test } from "bun:test";
import { SWAP_ADAPTERS, SWAP_PUBLISH_CONDITIONS, SWAP_REFERENCE_BUNDLE, SWAP_RUNNER_SOURCE } from "@/packs/h3/swapPins";

test("swap pin data is complete: 40-hex revisions, 64-hex hashes, positive sizes, no duplicate paths", () => {
  expect(SWAP_RUNNER_SOURCE.revision).toMatch(/^[0-9a-f]{40}$/);
  const all = [...SWAP_REFERENCE_BUNDLE, ...SWAP_ADAPTERS];
  for (const file of all) {
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.bytes).toBeGreaterThan(0);
    if (file.revision !== null) expect(file.revision).toMatch(/^[0-9a-f]{40}$/);
  }
  expect(new Set(all.map((file) => `${file.repo}/${file.path}`)).size).toBe(all.length);
  expect(SWAP_REFERENCE_BUNDLE.every((file) => file.revision !== null)).toBe(true);
});

test("the swap pin is data only and names the conditions before publishing", () => {
  expect(SWAP_PUBLISH_CONDITIONS).toHaveLength(3);
  expect(SWAP_PUBLISH_CONDITIONS[2]).toContain("owner");
  expect(SWAP_RUNNER_SOURCE.patch).toContain("not in this repository");
});
