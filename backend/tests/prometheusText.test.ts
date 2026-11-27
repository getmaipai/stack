import { expect, test } from "bun:test";
import { renderGauges } from "@/lib/prometheusText";

test("renders gauge HELP and TYPE lines in deterministic input order", () => {
  const text = renderGauges([
    { name: "maipai_stack_one", help: "First gauge", samples: [{ value: 2 }, { value: 1 }] },
    { name: "maipai_stack_two", help: "Second gauge", samples: [{ value: 3 }] },
  ]);
  expect(text).toBe("# HELP maipai_stack_one First gauge\n# TYPE maipai_stack_one gauge\nmaipai_stack_one 2\nmaipai_stack_one 1\n# HELP maipai_stack_two Second gauge\n# TYPE maipai_stack_two gauge\nmaipai_stack_two 3\n");
});

test("escapes label values and omits null and non-finite samples", () => {
  const text = renderGauges([{ name: "maipai_stack_role", help: "Role bytes", samples: [
    { labels: { role: 'a\\b"c\nd' }, value: 7 }, { value: null }, { value: Number.NaN },
  ] }]);
  expect(text).toContain('maipai_stack_role{role="a\\\\b\\"c\\nd"} 7');
  expect(text).not.toContain("NaN");
});

test("empty input renders an empty string", () => {
  expect(renderGauges([])).toBe("");
});
