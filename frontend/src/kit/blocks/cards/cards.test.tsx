import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";
import { StatusPill } from "@/kit/blocks/cards/StatusPill";
import { MetricCard } from "@/kit/blocks/cards/MetricCard";
import { ResourceRow } from "@/kit/blocks/cards/ResourceRow";
import { CategoryTile } from "@/kit/blocks/cards/CategoryTile";
import { ActionTile } from "@/kit/blocks/cards/ActionTile";
import { Sparkline } from "@/kit/blocks/cards/Sparkline";

afterEach(cleanup);

test("StatusPill shows the label and a dot only when the status carries one", () => {
  render(<StatusPill status="running" />);
  expect(document.body.textContent).toContain("Running");
  expect(document.querySelector("span > span[aria-hidden]")).toBeTruthy();
  cleanup();
  render(<StatusPill status="loading" />);
  expect(document.body.textContent).toContain("Loading");
  expect(document.querySelector("span > span[aria-hidden]")).toBeNull();
});

test("MetricCard renders the count, label and a linked state", () => {
  render(<MemoryRouter><MetricCard icon="Box" hue="--cat-models" count={38} label="Installed Components" state="2 updates available" stateHref="/settings/updates" /></MemoryRouter>);
  expect(document.body.textContent).toContain("38");
  expect(document.body.textContent).toContain("Installed Components");
  expect(document.querySelector('a[href="/settings/updates"]')?.textContent).toBe("2 updates available");
});

test("Sparkline renders a polyline that skips null samples as gaps", () => {
  const points = [
    { at: "2026-09-20T00:00:00Z", value: 10 },
    { at: "2026-09-20T00:01:00Z", value: 12 },
    { at: "2026-09-20T00:02:00Z", value: null },
    { at: "2026-09-20T00:03:00Z", value: 18 },
    { at: "2026-09-20T00:04:00Z", value: 20 },
  ];
  render(<Sparkline points={points} hue="--primary" />);
  expect(document.querySelectorAll("polyline").length).toBe(2);
});

test("Sparkline with no samples announces that instead of drawing", () => {
  render(<Sparkline points={[{ at: "2026-09-20T00:00:00Z", value: null }]} hue="--primary" />);
  expect(document.querySelector("svg")).toBeNull();
  expect(document.body.textContent).toContain("No samples yet");
});

test("Sparkline with exactly one real sample draws a dot, not the empty state", () => {
  render(<Sparkline points={[{ at: "2026-09-20T00:00:00Z", value: 42 }]} hue="--primary" />);
  expect(document.querySelector("svg")).toBeTruthy();
  expect(document.querySelector("circle")).toBeTruthy();
  expect(document.body.textContent).not.toContain("No samples yet");
});

test("ResourceRow shows the percent, capacity label and a tooltip trigger", () => {
  const series = [{ at: "2026-09-20T00:00:00Z", value: 18 }];
  render(<ResourceRow icon="Cpu" hue="--primary" label="CPU" percent={18} series={series} capacityLabel="4 of 16 cores" />);
  expect(document.body.textContent).toContain("18%");
  expect(document.body.textContent).toContain("4 of 16 cores");
});

test("CategoryTile links to the browse path with the installed count", () => {
  render(<MemoryRouter><CategoryTile icon="Box" hue="--cat-models" label="Models" installedCount={12} browsePath="/models" /></MemoryRouter>);
  const link = document.querySelector('a[href="/models"]');
  expect(link?.textContent).toContain("Models");
  expect(link?.textContent).toContain("12 installed");
});

test("ActionTile fires onClick", () => {
  let clicked = false;
  render(<ActionTile icon="RefreshCw" label="Check for Updates" subtitle="Scan all components" onClick={() => { clicked = true; }} />);
  fireEvent.click(document.querySelector("button")!);
  expect(clicked).toBe(true);
});
