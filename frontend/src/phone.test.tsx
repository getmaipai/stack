import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { ActionList } from "@/kit/blocks/phone/ActionList";
import { ChipRow } from "@/kit/blocks/phone/ChipRow";
import { DetailCard } from "@/kit/blocks/phone/DetailCard";
import { ListRow } from "@/kit/blocks/phone/ListRow";
import { TabBar } from "@/kit/blocks/phone/TabBar";

afterEach(cleanup);

test("the 400px phone surface exposes five tabs and 44px touch targets", () => {
  render(<>
    <TabBar activePath="/" onNavigate={() => undefined} />
    <main data-phone-shell style={{ width: 400 }}>
      <ListRow name="Family chat" subtitle="Ready" status="Loaded" onClick={() => undefined} />
      <ChipRow chips={["All", "Ready"]} active="All" onSelect={() => undefined} />
      <DetailCard rows={[{ label: "Nickname", editable: true, placeholder: "Optional" }, { label: "Group", value: "Family chat", onClick: () => undefined }]} />
      <ActionList actions={[{ label: "Restart", onClick: async () => undefined }, { label: "Remove", destructive: true, onClick: async () => undefined }]} />
    </main>
  </>);

  expect(document.querySelector("[data-phone-shell]")?.getAttribute("style")).toContain("width: 400px");
  expect(Array.from(document.querySelectorAll('[aria-label="Phone navigation"] button')).map((button) => button.textContent?.trim())).toEqual(["Overview", "Things", "Ask", "Alerts", "Settings"]);
  const interactive = Array.from(document.querySelectorAll("[data-phone-shell] button, [data-phone-shell] a, [data-phone-shell] input"));
  expect(interactive.length).toBeGreaterThanOrEqual(7);
  expect(interactive.every((element) => element.className.toString().includes("min-h-11") || element.className.toString().includes("min-h-14") || Number.parseInt((element as HTMLElement).style.minHeight, 10) >= 44)).toBe(true);
  expect(document.body.textContent?.indexOf("Restart")).toBeLessThan(document.body.textContent?.indexOf("Remove") ?? -1);
});
