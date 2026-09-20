// Hand-written Zod mirror of ../schemas/stt-transcribe-response.schema.json.
import { z } from "zod";

export const SttTranscribeResponse = z.object({ text: z.string() }).strict();
export type SttTranscribeResponse = z.infer<typeof SttTranscribeResponse>;
