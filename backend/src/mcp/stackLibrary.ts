import { getLibraryPage, listLibrary, searchLibrary } from "@/lib/library";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type RpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown> };
type RpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

export function handleMcpRequest(request: RpcRequest): RpcResponse | null {
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return null;
  const id = request.id ?? null;
  if (request.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stack-library", version: "0.1.0" } } };
  if (request.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: [
    { name: "list_installed", description: "List locally fetched documentation for installed models and engines.", inputSchema: { type: "object", properties: {} } },
    { name: "get_doc", description: "Read a locally fetched Library page.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "search", description: "Search locally fetched Library pages.", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
  ] } };
  if (request.method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${request.method}` } };
  const params = request.params ?? {};
  const name = String(params.name ?? "");
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if (name === "list_installed") return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(listLibrary()) }] } };
  if (name === "get_doc") { const page = getLibraryPage(String(args.id ?? "")); return page ? { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: page.markdown }], structuredContent: page } } : { jsonrpc: "2.0", id, error: { code: -32004, message: "Unknown Library page." } }; }
  if (name === "search") return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(searchLibrary(String(args.q ?? ""))) }] } };
  return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
}

async function main(): Promise<void> {
  const server = new Server({ name: "stack-library", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "list_installed", description: "List locally fetched documentation for installed models and engines.", inputSchema: { type: "object", properties: {} } },
    { name: "get_doc", description: "Read a locally fetched Library page.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "search", description: "Search locally fetched Library pages.", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (name === "list_installed") return { content: [{ type: "text", text: JSON.stringify(listLibrary()) }] };
    if (name === "get_doc") { const page = getLibraryPage(String(args.id ?? "")); return page ? { content: [{ type: "text", text: page.markdown }] } : { isError: true, content: [{ type: "text", text: "Unknown Library page." }] }; }
    if (name === "search") return { content: [{ type: "text", text: JSON.stringify(searchLibrary(String(args.q ?? ""))) }] };
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) await main();
