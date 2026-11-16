import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { STACK_STAGED_MODELS, STACK_MODELS } from "@/lib/modelCatalog";

const LIVE_HUB = "/usr/local/maipai-home/stack/data/models/hub";

describe("staged model pins", () => {
  test("every pin names a source, a revision, a licence, a sha256 and a size", () => {
    for (const pin of STACK_STAGED_MODELS) {
      expect(pin.repo).toBeTruthy();
      expect(pin.revision).toBeTruthy();
      expect(["MIT", "Apache-2.0"]).toContain(pin.license!);
      expect(pin.download!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.download!.approx_bytes).toBeGreaterThan(0);
      expect(pin.download!.hub_file).toBeTruthy();
    }
  });
  test("they are not first-run installs until an engine uses them", () => {
    const ids = new Set(STACK_MODELS.map((pin) => pin.id));
    for (const pin of STACK_STAGED_MODELS) expect(ids.has(pin.id)).toBe(false);
  });
  test("the ids are unique and the URLs are the authors' own", () => {
    expect(new Set(STACK_STAGED_MODELS.map((pin) => pin.id)).size).toBe(STACK_STAGED_MODELS.length);
    for (const pin of STACK_STAGED_MODELS) expect(pin.download!.url).toMatch(/^https:\/\/(github\.com\/(TencentARC|xinntao)\/|huggingface\.co\/ResembleAI\/)/);
  });
  test.skipIf(!existsSync(LIVE_HUB))("on the Studio, each blob is installed with the pinned size", () => {
    for (const pin of STACK_STAGED_MODELS) {
      const blob = `${LIVE_HUB}/models--${pin.repo!.replace("/", "--")}/blobs/${pin.download!.sha256}`;
      expect(statSync(blob).size).toBe(pin.download!.approx_bytes);
    }
  });
});
