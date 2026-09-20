import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { Empty } from "@/kit/blocks/states/Empty";
import { Loading } from "@/kit/blocks/states/Loading";
import { ErrorState } from "@/kit/blocks/states/ErrorState";

afterEach(cleanup);

test("Empty shows one sentence and fires its one action", () => {
  let clicked = false;
  render(<Empty message="No models are installed yet." actionLabel="Install a model" onAction={() => { clicked = true; }} />);
  expect(document.body.textContent).toContain("No models are installed yet.");
  fireEvent.click(document.querySelector("button")!);
  expect(clicked).toBe(true);
});

test("Empty with no action renders no button", () => {
  render(<Empty message="Nothing here yet." />);
  expect(document.querySelector("button")).toBeNull();
});

test("Loading renders skeleton rows matching the requested count", () => {
  render(<Loading rows={4} />);
  expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(4);
  expect(document.querySelector('[role="status"]')).toBeTruthy();
});

test("ErrorState shows the message and a recovery action", () => {
  let retried = false;
  render(<ErrorState message="The model list could not load." onRetry={() => { retried = true; }} />);
  expect(document.body.textContent).toContain("The model list could not load.");
  fireEvent.click(document.querySelector("button")!);
  expect(retried).toBe(true);
});
