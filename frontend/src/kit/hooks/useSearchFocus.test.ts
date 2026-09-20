import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { useSearchFocus } from "@/kit/hooks/useSearchFocus";

afterEach(cleanup);

function withInput(): HTMLInputElement {
  const input = document.createElement("input");
  document.body.appendChild(input);
  return input;
}

test("Cmd+K and / focus the input; Escape blurs it", () => {
  const input = withInput();
  renderHook(() => useSearchFocus({ current: input }));
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(document.activeElement).toBe(input);
  input.blur();
  fireEvent.keyDown(window, { key: "/" });
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(document.activeElement).not.toBe(input);
  input.remove();
});

test("/ does not steal focus while typing in another field", () => {
  const input = withInput();
  const other = document.createElement("input");
  document.body.appendChild(other);
  other.focus();
  renderHook(() => useSearchFocus({ current: input }));
  fireEvent.keyDown(other, { key: "/" });
  expect(document.activeElement).toBe(other);
  input.remove();
  other.remove();
});

test("enableCmdK: false leaves Cmd+K to another owner (a page-local field inside the persistent shell)", () => {
  const input = withInput();
  renderHook(() => useSearchFocus({ current: input }, { enableCmdK: false }));
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(document.activeElement).not.toBe(input);
  fireEvent.keyDown(window, { key: "/" });
  expect(document.activeElement).toBe(input);
  input.remove();
});
