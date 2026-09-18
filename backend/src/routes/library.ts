import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema, idParamSchema } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { requireOperator } from "@/lib/operator";
import { fetchLibrary, getLibraryPage, listLibrary, searchLibrary } from "@/lib/library";
import { showroom, showroomLibrary } from "@/showroom/fixture";

const item = z.object({ id: z.string(), kind: z.enum(["model", "engine"]), title: z.string(), source: z.string(), licence: z.string(), fetchedAt: z.string(), revision: z.string(), size: z.number().int() });
const listRoute = createRoute({ method: "get", path: "/", tags: ["Library"], middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ library: z.array(item) }) } }, description: "List locally fetched Library pages." } } });
const pageRoute = createRoute({ method: "get", path: "/{id}", tags: ["Library"], middleware: [requireClientOrOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ page: z.unknown() }) } }, description: "Read a local Library page." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown Library page." } } });
const searchRoute = createRoute({ method: "get", path: "/search", tags: ["Library"], middleware: [requireClientOrOperator] as const, request: { query: z.object({ q: z.string().default("") }) }, responses: { 200: { content: { "application/json": { schema: z.object({ results: z.array(z.unknown()) }) } }, description: "Search local Library pages." } } });
const fetchRoute = createRoute({ method: "post", path: "/fetch", tags: ["Library"], middleware: [requireOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ fetched: z.number().int(), skipped: z.boolean() }) } }, description: "Fetch Library docs when updates are enabled." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Library fetch failed." } } });

export const libraryRoutes = apiRouter();
libraryRoutes.openapi(listRoute, (c) => c.json({ library: showroom() ? showroomLibrary : listLibrary() } as never, 200));
libraryRoutes.openapi(searchRoute, (c) => { const query = c.req.valid("query").q; return c.json({ results: showroom() ? showroomLibrary.filter((entry) => `${entry.title} ${entry.markdown}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : searchLibrary(query) } as never, 200); });
libraryRoutes.openapi(pageRoute, (c) => { const id = c.req.valid("param").id; const page = showroom() ? showroomLibrary.find((entry) => entry.id === id) : getLibraryPage(id); return page ? c.json({ page } as never, 200) : c.json({ error: "Unknown Library page." }, 404); });
libraryRoutes.openapi(fetchRoute, async (c) => { if (showroom()) return c.json({ fetched: 0, skipped: false }, 200); try { return c.json(await fetchLibrary(), 200); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Library fetch failed." }, 400); } });
