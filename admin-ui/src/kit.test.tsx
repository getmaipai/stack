import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity } from "lucide-react";
import { StatTile } from "./kit";

describe("StatTile", () => {
  test("renders an accessible focused button when clickable", () => {
    const html = renderToStaticMarkup(<StatTile Icon={Activity} label="Requests" value="2" onOpen={() => {}} />);
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-label="Requests: 2. Show details"');
    expect(html).toContain("focus-visible:outline-ring");
  });
  test("stays a display tile when no action is supplied", () => {
    const html = renderToStaticMarkup(<StatTile Icon={Activity} label="Requests" value="2" />);
    expect(html.startsWith("<div")).toBe(true);
    expect(html).not.toContain("<button");
  });
});
