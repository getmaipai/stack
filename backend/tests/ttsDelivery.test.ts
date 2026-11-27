import { describe, expect, test } from "bun:test";
import { DeliveryGovernor, deliverSpeech, type DeliveryConfig } from "@/lib/ttsDelivery";

const config: DeliveryConfig = { adaptive: true, rtfHigh: 0.7, rtfLow: 0.5, loadHigh: 0.8, loadLow: 0.6, calmUtterances: 3, prerollMs: 300 };
function make(load = { v: 0.1 }, cfg = config) {
  const lines: string[] = [];
  return { g: new DeliveryGovernor(() => cfg, () => load.v, (l) => lines.push(l)), load, lines };
}
const calm = (g: DeliveryGovernor) => g.finish(0.2, 1);

describe("adaptive voice delivery", () => {
  test("flips to buffered on slow real-time factor and logs once", () => {
    const { g, lines } = make();
    for (let i = 0; i < 3; i++) g.finish(0.9, 1);
    expect(g.mode).toBe("buffered");
    expect(lines.length).toBe(1);
  });
  test("flips to buffered on high load", () => {
    const { g, load } = make();
    load.v = 0.9;
    expect(g.begin()).toBe("buffered");
  });
  test("returns to streaming only after exactly 3 calm replies", () => {
    const { g } = make();
    for (let i = 0; i < 3; i++) g.finish(0.9, 1);
    expect(g.mode).toBe("buffered");
    calm(g); calm(g);
    expect(g.mode).toBe("buffered");
    calm(g);
    expect(g.mode).toBe("streaming");
  });
  test("a non-calm reply resets the calm count", () => {
    const { g } = make();
    for (let i = 0; i < 3; i++) g.finish(0.9, 1);
    calm(g); calm(g); g.finish(0.6, 1); calm(g); calm(g);
    expect(g.mode).toBe("buffered");
    calm(g);
    expect(g.mode).toBe("streaming");
  });
  test("one slow reply never flips the mode", () => {
    const { g } = make();
    calm(g); calm(g); calm(g); calm(g);
    g.finish(1.5, 1);
    expect(g.mode).toBe("streaming");
    const first = make().g;
    first.finish(3, 1);
    expect(first.mode).toBe("streaming");
  });
  test("adaptive off never buffers", () => {
    const { g, load } = make({ v: 5 }, { ...config, adaptive: false });
    for (let i = 0; i < 6; i++) g.finish(3, 1);
    expect(g.begin()).toBe("streaming");
    expect(load.v).toBe(5);
    expect(g.mode).toBe("streaming");
  });
  test("buffered delivery sends header, silence pre-roll, then the audio", async () => {
    const { g, load } = make();
    load.v = 0.9;
    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    view.setUint16(22, 1, true); view.setUint32(24, 1000, true); view.setUint16(34, 16, true);
    const audio = new Uint8Array(2000).fill(7);
    const src = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(header); c.enqueue(audio); c.close(); } });
    const out = new Uint8Array(await new Response(deliverSpeech(src, g, 300)).arrayBuffer());
    expect(out.byteLength).toBe(44 + 600 + 2000);
    expect(out[44]).toBe(0);
    expect(out[644]).toBe(7);
  });
});
