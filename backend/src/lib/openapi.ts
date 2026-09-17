// MaiPai Stack's shared OpenAPI router and response schemas.
// Every route uses this factory so validation and errors stay consistent.
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "@/types";

export const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

export function errorResponses<const T extends Record<number, string>>(
  statuses: T,
): { [K in keyof T]: { content: { "application/json": { schema: typeof ErrorSchema } }; description: T[K] } } {
  const responses = {} as { [K in keyof T]: { content: { "application/json": { schema: typeof ErrorSchema } }; description: T[K] } };
  for (const key of Object.keys(statuses)) {
    const k = key as unknown as keyof T;
    responses[k] = { content: { "application/json": { schema: ErrorSchema } }, description: statuses[k] };
  }
  return responses;
}

export function idParamSchema<const Name extends string>(paramName: Name, example?: string): z.ZodObject<{ [K in Name]: z.ZodString }> {
  const shape = { [paramName]: z.string().openapi({ param: { name: paramName, in: "path" }, ...(example ? { example } : {}) }) };
  return z.object(shape) as z.ZodObject<{ [K in Name]: z.ZodString }>;
}

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional().openapi({
    param: { name: "limit", in: "query" },
    example: 50,
  }),
  cursor: z.string().optional().openapi({ param: { name: "cursor", in: "query" } }),
});

export function paginatedResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({ items: z.array(itemSchema), next_cursor: z.string().nullable() });
}

export function apiRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues.map((issue) => issue.message).join("; ");
        return c.json({ error: message }, 400);
      }
    },
  });
}
