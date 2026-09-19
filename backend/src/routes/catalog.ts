import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@/lib/openapi";
import { requireOperator } from "@/lib/operator";
import { STACK_CHAT_MODEL } from "@/lib/modelCatalog";
import { ENGINE_BINARIES } from "@/lib/engineCatalog";
import { detectHardware } from "@/lib/hardware";
import { proposeProfile } from "@/profiles";
import { hfUrl, huggingFaceSearchEnabled, resolveHuggingFace, searchHuggingFace } from "@/lib/hf";
import { licenceInfo } from "@/lib/licences";

const EntrySchema = z.object({ id: z.string(), name: z.string(), kind: z.enum(["model", "engine"]), roles: z.array(z.string()).optional(), licence: z.string().nullable(), licenceSentence: z.string(), licenceFlag: z.string(), licenceUrl: z.string().url().nullable(), sizeBytes: z.number().int().nullable(), source: z.string(), revision: z.string().nullable(), url: z.string().url().nullable(), sha256: z.string().nullable(), repo: z.string().nullable(), runsOnThisComputer: z.boolean().optional(), files: z.array(z.object({ name: z.string(), sizeBytes: z.number().int().nullable(), sha256: z.string().nullable(), url: z.string().url() })).optional() });
const searchRoute = createRoute({ method: "get", path: "/search", tags: ["Catalog"], summary: "Search the local catalog or Hugging Face", middleware: [requireOperator] as const, request: { query: z.object({ q: z.string().optional(), kind: z.enum(["model", "engine", "huggingface"]).optional() }) }, responses: { 200: { content: { "application/json": { schema: z.object({ enabled: z.boolean(), results: z.array(EntrySchema) }) } }, description: "Catalog entries or Hugging Face results." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid catalog search." } } });
const resolveRoute = createRoute({ method: "get", path: "/huggingface/resolve", tags: ["Catalog"], summary: "Resolve a Hugging Face repository before installation", middleware: [requireOperator] as const, request: { query: z.object({ repo: z.string().min(1) }) }, responses: { 200: { content: { "application/json": { schema: z.object({ result: EntrySchema }) } }, description: "Resolved immutable model details." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The repository could not be resolved." } } });

async function localResults(kind: "model" | "engine", query: string): Promise<z.infer<typeof EntrySchema>[]> {
  const needle = query.toLocaleLowerCase();
  const profile = proposeProfile(await detectHardware());
  if (kind === "engine") return ENGINE_BINARIES.filter((entry) => !needle || `${entry.id} ${entry.label}`.toLocaleLowerCase().includes(needle)).map((entry) => ({ id: entry.id, name: entry.label, kind: "engine" as const, licence: "Apache-2.0", licenceSentence: licenceInfo("Apache-2.0").sentence, licenceFlag: licenceInfo("Apache-2.0").flag, licenceUrl: licenceInfo("Apache-2.0").url, sizeBytes: entry.archive.approxBytes, source: "MaiPai Catalog", revision: entry.id, url: entry.archive.url, sha256: entry.archive.sha256, repo: null, runsOnThisComputer: entry.platform === process.platform && entry.arch === process.arch && (!entry.requiresNvidia || (profile?.minVramGb ?? 0) > 0) }));
  const entry = STACK_CHAT_MODEL;
  const tier = entry.sizing && typeof entry.sizing === "object" && "profile" in entry.sizing ? String(entry.sizing.profile) : null;
  const tierOrder = ["p16", "p32", "p64", "p128"];
  const runsOnThisComputer = tier !== null && profile !== null && tierOrder.indexOf(profile.id) >= tierOrder.indexOf(tier);
  const info = licenceInfo(entry.license);
  return !needle || `${entry.id} ${entry.role}`.toLocaleLowerCase().includes(needle) ? [{ id: entry.id, name: entry.id, kind: "model" as const, roles: [entry.role], licence: entry.license ?? null, licenceSentence: info.sentence, licenceFlag: info.flag, licenceUrl: info.url, sizeBytes: entry.download?.approx_bytes ?? null, source: "MaiPai Catalog", revision: entry.revision ?? null, url: entry.download?.url ?? null, sha256: entry.download?.sha256 ?? null, repo: "Qwen/Qwen3-1.7B-GGUF", runsOnThisComputer }] : [];
}

export const catalogRoutes = apiRouter();
catalogRoutes.openapi(searchRoute, async (c) => {
  const query = c.req.valid("query");
  if (query.kind !== "huggingface") return c.json({ enabled: true, results: await localResults(query.kind ?? "model", query.q ?? "") }, 200);
  if (!huggingFaceSearchEnabled()) return c.json({ enabled: false, results: [] }, 200);
  const q = query.q?.trim() ?? "";
  if (!q) return c.json({ enabled: true, results: [] }, 200);
  try {
    const entries = await searchHuggingFace(q);
    return c.json({ enabled: true, results: entries.map((entry) => ({ id: entry.repo, name: entry.name, kind: "model" as const, roles: ["unknown"], licence: null, licenceSentence: licenceInfo(null).sentence, licenceFlag: licenceInfo(null).flag, licenceUrl: null, sizeBytes: null, source: "Hugging Face", revision: null, url: hfUrl(entry.repo), sha256: null, repo: entry.repo, files: [] })) }, 200);
  } catch { return c.json({ error: "Hugging Face search could not be completed." }, 400); }
});
catalogRoutes.openapi(resolveRoute, async (c) => {
  if (!huggingFaceSearchEnabled()) return c.json({ error: "Hugging Face search is off." }, 400);
  try {
    const result = await resolveHuggingFace(c.req.valid("query").repo);
    const info = licenceInfo(result.licence);
    const sizeBytes = result.files.length > 0 && result.files.every((file) => file.sizeBytes !== null) ? result.files.reduce((total, file) => total + (file.sizeBytes ?? 0), 0) : null;
    const installFile = result.files.find((file) => file.name.toLowerCase().endsWith(".gguf")) ?? result.files[0];
    return c.json({ result: { id: result.repo, name: result.name, kind: "model" as const, roles: [result.role], licence: result.licence, licenceSentence: info.sentence, licenceFlag: result.gated ? "gated" : info.flag, licenceUrl: info.url, sizeBytes, source: "Hugging Face", revision: result.revision, url: installFile?.url ?? null, sha256: installFile?.sha256 ?? null, repo: result.repo, files: result.files } }, 200);
  } catch { return c.json({ error: "Hugging Face could not resolve that repository." }, 400); }
});
