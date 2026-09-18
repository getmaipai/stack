import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@/lib/openapi";
import { requireOperator } from "@/lib/operator";
import { STACK_CHAT_MODEL } from "@/lib/modelCatalog";
import { ENGINE_BINARIES } from "@/lib/engineCatalog";
import { updatesEnabled } from "@/updates/check";
import { detectHardware } from "@/lib/hardware";
import { proposeProfile } from "@/profiles";

const EntrySchema = z.object({ id: z.string(), name: z.string(), kind: z.enum(["model", "engine"]), roles: z.array(z.string()).optional(), licence: z.string().nullable(), sizeBytes: z.number().int().nullable(), source: z.string(), revision: z.string().nullable(), url: z.string().url().nullable(), sha256: z.string().nullable(), repo: z.string().nullable(), runsOnThisComputer: z.boolean().optional(), files: z.array(z.object({ name: z.string(), sizeBytes: z.number().int().nullable(), url: z.string().url() })).optional() });
const searchRoute = createRoute({ method: "get", path: "/search", tags: ["Catalog"], summary: "Search the local catalog or Hugging Face", middleware: [requireOperator] as const, request: { query: z.object({ q: z.string().optional(), kind: z.enum(["model", "engine", "huggingface"]).optional() }) }, responses: { 200: { content: { "application/json": { schema: z.object({ enabled: z.boolean(), results: z.array(EntrySchema) }) } }, description: "Catalog entries or Hugging Face results." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid catalog search." } } });

async function localResults(kind: "model" | "engine", query: string): Promise<z.infer<typeof EntrySchema>[]> {
  const needle = query.toLocaleLowerCase();
  const profile = proposeProfile(await detectHardware());
  if (kind === "engine") return ENGINE_BINARIES.filter((entry) => !needle || `${entry.id} ${entry.label}`.toLocaleLowerCase().includes(needle)).map((entry) => ({ id: entry.id, name: entry.label, kind: "engine" as const, licence: "Apache-2.0", sizeBytes: entry.archive.approxBytes, source: "MaiPai Catalog", revision: entry.id, url: entry.archive.url, sha256: entry.archive.sha256, repo: null, runsOnThisComputer: entry.platform === process.platform && entry.arch === process.arch && (!entry.requiresNvidia || (profile?.minVramGb ?? 0) > 0) }));
  const entry = STACK_CHAT_MODEL;
  const tier = entry.sizing && typeof entry.sizing === "object" && "profile" in entry.sizing ? String(entry.sizing.profile) : null;
  const tierOrder = ["p16", "p32", "p64", "p128"];
  const runsOnThisComputer = tier !== null && profile !== null && tierOrder.indexOf(profile.id) >= tierOrder.indexOf(tier);
  return !needle || `${entry.id} ${entry.role}`.toLocaleLowerCase().includes(needle) ? [{ id: entry.id, name: entry.id, kind: "model" as const, roles: [entry.role], licence: entry.license ?? null, sizeBytes: entry.download?.approx_bytes ?? null, source: "MaiPai Catalog", revision: entry.revision ?? null, url: entry.download?.url ?? null, sha256: entry.download?.sha256 ?? null, repo: "Qwen/Qwen3-1.7B-GGUF", runsOnThisComputer }] : [];
}

export const catalogRoutes = apiRouter();
catalogRoutes.openapi(searchRoute, async (c) => {
  const query = c.req.valid("query");
  if (query.kind !== "huggingface") return c.json({ enabled: true, results: await localResults(query.kind ?? "model", query.q ?? "") }, 200);
  if (!updatesEnabled()) return c.json({ enabled: false, results: [] }, 200);
  const q = query.q?.trim() ?? "";
  if (!q) return c.json({ enabled: true, results: [] }, 200);
  const response = await fetch(`https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=gguf&limit=20`, { headers: { "if-none-match": "", "user-agent": "maipai-stack/0.1.0 (catalog-search)" } });
  if (!response.ok) return c.json({ error: `Hugging Face search returned ${response.status}.` }, 400);
  const entries = await response.json() as Array<{ id?: string; pipeline_tag?: string; tags?: string[] }>;
  return c.json({ enabled: true, results: entries.filter((entry) => entry.id).map((entry) => ({ id: entry.id!, name: entry.id!, kind: "model" as const, roles: [entry.pipeline_tag === "text-to-image" ? "image" : "chat"], licence: null, sizeBytes: null, source: "Hugging Face", revision: "main", url: `https://huggingface.co/${entry.id}`, sha256: null, repo: entry.id!, files: [] })) }, 200);
});
