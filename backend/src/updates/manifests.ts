import { z } from "zod";

export const TargetSchema = z.object({ url: z.string().url(), sha256: z.string().length(64), size: z.number().int().nonnegative(), signature: z.string() });
export const UpdateManifestSchema = z.object({ version: z.string(), notes: z.string(), pub_date: z.string(), platforms: z.record(z.string(), TargetSchema) });
export type UpdateManifest = z.infer<typeof UpdateManifestSchema>;
export type UpdateClass = "app" | "engines" | "models";
export const MANIFEST_URLS: Record<UpdateClass, string> = {
  app: "https://github.com/getmaipai/stack/releases/latest/download/app.json",
  engines: "https://github.com/getmaipai/stack/releases/latest/download/engines.json",
  models: "https://github.com/getmaipai/stack/releases/latest/download/models.json",
};

export const MODEL_INDEX_URL = "https://github.com/getmaipai/catalog/releases/latest/download/model-index.json";
