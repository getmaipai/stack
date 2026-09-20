import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { ConfirmDialog } from "@/kit/blocks/ConfirmDialog";

afterEach(cleanup);

test("shows the affected files and dependents, and fires confirm or cancel", async () => {
  let confirmed = false;
  let cancelled = false;
  render(<ConfirmDialog open title="Remove qwen3-27b-instruct?" affectedFiles={["qwen3-27b-instruct.gguf"]} affectedDependents={["Chat role", "Coding role"]} onConfirm={() => { confirmed = true; }} onCancel={() => { cancelled = true; }} />);
  await waitFor(() => expect(document.body.textContent).toContain("Remove qwen3-27b-instruct?"));
  expect(document.body.textContent).toContain("qwen3-27b-instruct.gguf");
  expect(document.body.textContent).toContain("Chat role");
  fireEvent.click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Remove")!);
  expect(confirmed).toBe(true);
  fireEvent.click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Cancel")!);
  expect(cancelled).toBe(true);
});

test("renders nothing affected-related when no files or dependents are given", async () => {
  render(<ConfirmDialog open title="Clear cache?" onConfirm={() => undefined} onCancel={() => undefined} />);
  await waitFor(() => expect(document.body.textContent).toContain("Clear cache?"));
  expect(document.body.textContent).not.toContain("Files removed");
  expect(document.body.textContent).not.toContain("Affects");
});
