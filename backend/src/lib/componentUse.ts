// When a model or picture family was last used, kept in `meta` so Home's
// Models and storage page can say "last used 3 weeks ago". A raw id (a
// model record or a picture family) is stored; the component list reads the
// newest across the ids a component holds. One write per id per minute, and
// a failure here never touches the request that was served.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";

const KEY = (id: string): string => `component.lastUsed.${id}`;
const written = new Map<string, number>();

export function noteComponentUse(id: string | null | undefined): void {
  if (!id) return;
  try {
    if (Date.now() - (written.get(id) ?? 0) < 60_000) return;
    written.set(id, Date.now());
    const value = new Date().toISOString();
    db.insert(meta).values({ key: KEY(id), value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run();
  } catch { /* a missing timestamp never fails a request */ }
}

export function lastUsedOf(ids: string[]): string | null {
  let newest: string | null = null;
  for (const id of ids) {
    const value = db.select().from(meta).where(eq(meta.key, KEY(id))).get()?.value ?? null;
    if (value && (!newest || value > newest)) newest = value;
  }
  return newest;
}

export function __forgetUseForTests(): void { written.clear(); }
