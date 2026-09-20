import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { useState } from "react";
import { useFocusReturn } from "@/kit/hooks/useFocusReturn";

afterEach(cleanup);

function Demo() {
  const [open, setOpen] = useState(false);
  useFocusReturn(open);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>Row</button>
      {open && <button type="button" onClick={() => setOpen(false)} data-testid="close">Close</button>}
    </div>
  );
}

test("focus returns to the triggering element when the pane closes", () => {
  render(<Demo />);
  const row = document.querySelector("button")! as HTMLButtonElement;
  row.focus();
  fireEvent.click(row);
  const close = document.querySelector('[data-testid="close"]')! as HTMLButtonElement;
  fireEvent.click(close);
  expect(document.activeElement).toBe(row);
});
