import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Hash a file with bounded memory: each chunk is at most 16 MiB. */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 16 * 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}
