import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";
import { useFacetSort } from "@/kit/hooks/useFacetSort";

afterEach(cleanup);

test("mode, facet, sort and view default and update immediately", () => {
  const { result } = renderHook(() => useFacetSort({ facet: "all" }), { wrapper: MemoryRouter });
  expect(result.current[0]).toEqual({ mode: "installed", facet: "all", sort: "name", view: "list", filter: "" });
  act(() => result.current[1].setMode("browse"));
  expect(result.current[0].mode).toBe("browse");
  act(() => result.current[1].setView("grid"));
  expect(result.current[0].view).toBe("grid");
});

test("the typed filter debounces before landing in state", async () => {
  const { result } = renderHook(() => useFacetSort(), { wrapper: MemoryRouter });
  act(() => result.current[1].setFilter("qwen"));
  expect(result.current[0].filter).toBe("qwen");
  await waitFor(() => expect(result.current[0].filter).toBe("qwen"));
});
