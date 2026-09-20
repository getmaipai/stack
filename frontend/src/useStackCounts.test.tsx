import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useStackCounts } from "@/hooks/use-stack-counts";

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function stub(responses: Record<string, unknown>): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://local").pathname;
    const known = Object.entries(responses).find(([key]) => path.endsWith(key));
    return new Response(JSON.stringify(known ? known[1] : {}), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("components installed counts engines that are actually installed, not just compatible with this machine", async () => {
  stub({
    "/updates": { app: { available: null }, engines: { available: null }, models: { available: null } },
    "/models": { models: [{}, {}] },
    "/engines": { engines: [
      { id: "a", label: "A", platform: "darwin", arch: "arm64", verified: true, installed: true, matchesThisMachine: true, running: null, currentTag: null, newestTag: null, current: true, notCurrent: false, needsRestart: false, state: "current" },
      { id: "b", label: "B", platform: "darwin", arch: "arm64", verified: true, installed: false, matchesThisMachine: true, running: null, currentTag: null, newestTag: null, current: false, notCurrent: true, needsRestart: false, state: "notCurrent" },
      { id: "c", label: "C", platform: "darwin", arch: "arm64", verified: true, installed: false, matchesThisMachine: true, running: null, currentTag: null, newestTag: null, current: false, notCurrent: true, needsRestart: false, state: "notCurrent" },
    ] },
    "/roles": { roles: [] },
    "/health": { health: [] },
  });
  const { result } = renderHook(() => useStackCounts());
  await waitFor(() => expect(result.current.componentsInstalled).toBe(3));
});
