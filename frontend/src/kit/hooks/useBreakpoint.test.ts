import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { useBreakpoint } from "@/kit/hooks/useBreakpoint";

afterEach(cleanup);

function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

test("classifies the four spec tiers and updates on resize", () => {
  setWidth(400);
  const { result } = renderHook(() => useBreakpoint());
  expect(result.current.tier).toBe("phone");
  act(() => setWidth(800));
  expect(result.current.tier).toBe("tablet");
  act(() => setWidth(1000));
  expect(result.current.tier).toBe("narrow");
  act(() => setWidth(1440));
  expect(result.current.tier).toBe("wide");
});

test("under and atLeast read the current width", () => {
  setWidth(1000);
  const { result } = renderHook(() => useBreakpoint());
  expect(result.current.under(1280)).toBe(true);
  expect(result.current.atLeast(960)).toBe(true);
  expect(result.current.atLeast(1280)).toBe(false);
});
