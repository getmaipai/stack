import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { useSelectionPane } from "@/kit/hooks/useSelectionPane";

afterEach(cleanup);

test("selecting a row opens it, selecting another replaces it, selecting the same closes it", () => {
  const { result } = renderHook(() => useSelectionPane());
  expect(result.current.selectedId).toBeNull();
  act(() => result.current.select("row-1"));
  expect(result.current.selectedId).toBe("row-1");
  act(() => result.current.select("row-2"));
  expect(result.current.selectedId).toBe("row-2");
  act(() => result.current.select("row-2"));
  expect(result.current.selectedId).toBeNull();
});

test("Escape closes the open pane", () => {
  const { result } = renderHook(() => useSelectionPane());
  act(() => result.current.select("row-1"));
  expect(result.current.selectedId).toBe("row-1");
  act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
  expect(result.current.selectedId).toBeNull();
});
