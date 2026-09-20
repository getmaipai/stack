import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

export type BrowserMode = "installed" | "browse" | "updates" | "recommended";
export type BrowserView = "list" | "grid";

export interface FacetSortState {
  mode: BrowserMode;
  facet: string;
  sort: string;
  view: BrowserView;
  filter: string;
}

export interface FacetSortActions {
  setMode: (mode: BrowserMode) => void;
  setFacet: (facet: string) => void;
  setSort: (sort: string) => void;
  setView: (view: BrowserView) => void;
  setFilter: (filter: string) => void;
}

export interface FacetSortDefaults {
  mode?: BrowserMode;
  facet?: string;
  sort?: string;
  view?: BrowserView;
}

// Filter, sort, facet and mode live in the URL (spec: "state in the URL
// search params so it survives the pane opening and closing"). Only the
// typed filter text is debounced (250ms) before it reaches the URL and
// the caller's data fetch, so keystrokes don't churn navigation history.
export function useFacetSort(defaults: FacetSortDefaults = {}): [FacetSortState, FacetSortActions] {
  const [params, setParams] = useSearchParams();
  const [filterInput, setFilterInput] = useState(params.get("q") ?? "");
  const lastWritten = useRef(filterInput);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      lastWritten.current = filterInput;
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (filterInput) next.set("q", filterInput);
        else next.delete("q");
        return next;
      }, { replace: true });
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterInput]);

  // Resync when the URL's own "q" changes from outside this hook's own
  // debounced write (browser back/forward, or another lifter of the
  // same search params) rather than only ever reading it once at mount.
  useEffect(() => {
    const fromUrl = params.get("q") ?? "";
    if (fromUrl !== lastWritten.current) {
      lastWritten.current = fromUrl;
      setFilterInput(fromUrl);
    }
  }, [params]);

  const set = useCallback((key: string, value: string) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set(key, value);
      return next;
    }, { replace: true });
  }, [setParams]);

  const state: FacetSortState = {
    mode: (params.get("mode") as BrowserMode | null) ?? defaults.mode ?? "installed",
    facet: params.get("facet") ?? defaults.facet ?? "all",
    sort: params.get("sort") ?? defaults.sort ?? "name",
    view: (params.get("view") as BrowserView | null) ?? defaults.view ?? "list",
    filter: filterInput,
  };

  return [state, {
    setMode: (mode) => set("mode", mode),
    setFacet: (facet) => set("facet", facet),
    setSort: (sort) => set("sort", sort),
    setView: (view) => set("view", view),
    setFilter: setFilterInput,
  }];
}
