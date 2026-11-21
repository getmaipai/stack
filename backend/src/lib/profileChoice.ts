// The saved profile choice (ADMIN-05): which of the three modes the person
// chose and the memory it was judged on, kept in `meta`, so a later
// recommend can say "your memory changed, plan again?" and ask before it
// switches anything.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";
import type { ProfileMode } from "@/lib/profilePlanner";

const KEY = "profile.choice";
export interface SavedChoice { mode: ProfileMode; tier: string | null; memory_gb: number; at: string }

export function readChoice(): SavedChoice | null {
  try {
    const raw = db.select().from(meta).where(eq(meta.key, KEY)).get()?.value;
    if (!raw) return null;
    const value = JSON.parse(raw) as SavedChoice;
    return value && typeof value.memory_gb === "number" && typeof value.mode === "string" ? value : null;
  } catch { return null; }
}
export function writeChoice(choice: SavedChoice): void {
  const value = JSON.stringify(choice);
  db.insert(meta).values({ key: KEY, value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run();
}
export function clearChoiceForTests(): void { db.delete(meta).where(eq(meta.key, KEY)).run(); }

/** Matched and Custom recommended follow the memory: a changed figure asks to plan again. Custom never does. */
export function replanNeeded(saved: SavedChoice | null, memoryGb: number): { needed: boolean; reason: string | null } {
  if (!saved || saved.mode === "custom" || saved.memory_gb === memoryGb) return { needed: false, reason: null };
  return { needed: true, reason: `This computer's memory is now ${memoryGb} GB; the saved ${saved.mode === "matched" ? "matched" : "recommended"} setup was planned for ${saved.memory_gb} GB. Plan again to use the new memory; nothing changes until you accept.` };
}
