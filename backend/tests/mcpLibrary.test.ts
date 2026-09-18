import { expect, test } from "bun:test";
import { handleMcpRequest } from "@/mcp/stackLibrary";

test("stack-library exposes the standard read-only tools", () => {
  const initialized = handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
  expect(initialized?.result).toMatchObject({ capabilities: { tools: {} }, serverInfo: { name: "stack-library" } });
  const tools = handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect((tools?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(["list_installed", "get_doc", "search"]);
});
