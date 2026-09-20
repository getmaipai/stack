import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { useConfirm } from "@/kit/hooks/useConfirm";

afterEach(cleanup);

test("ask sets the target, clear resets it", () => {
  const { result } = renderHook(() => useConfirm<{ id: string }>());
  expect(result.current.target).toBeNull();
  act(() => result.current.ask({ id: "model-1" }));
  expect(result.current.target).toEqual({ id: "model-1" });
  act(() => result.current.clear());
  expect(result.current.target).toBeNull();
});
