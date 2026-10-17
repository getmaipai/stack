// VIDEO-LTX-01: a licence an admin accepted before a component installed. The Stack never redistributes weights: an admin's own
// computer downloads them, and for a model whose licence has terms beyond "open" (LTX-2.x asks a business over a revenue line
// for its own licence) the install waits until Home sends the id of the notice the admin read and accepted. The record is one
// small file beside the models, written once, and read on every later install so the question is asked once. `by` is an opaque
// label Home sends (never a name the Stack interprets); the Stack has no people of its own.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@/lib/paths";

export interface LicenceNotice {
  /** What an acceptance names: the licence and its date, so a changed licence is asked about again. */
  id: string;
  name: string;
  url: string;
  /** Plain-word points, shown to the admin before they accept. */
  summary: string[];
}
export interface LicenceAcceptance { licence: string; accepted_at: string; by: string | null }

const file = (): string => join(dataDir, "licence-acceptances.json");
function read(): Record<string, LicenceAcceptance> {
  try { return JSON.parse(readFileSync(file(), "utf8")) as Record<string, LicenceAcceptance>; } catch { return {}; }
}

export function licenceAcceptance(noticeId: string): LicenceAcceptance | null {
  const found = read()[noticeId];
  return found && found.licence === noticeId ? found : null;
}
export function recordLicenceAcceptance(noticeId: string, by: string | null, now = new Date()): LicenceAcceptance {
  const existing = licenceAcceptance(noticeId);
  if (existing) return existing;
  const record: LicenceAcceptance = { licence: noticeId, accepted_at: now.toISOString(), by: by ? by.slice(0, 200) : null };
  mkdirSync(dirname(file()), { recursive: true });
  const temp = `${file()}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...read(), [noticeId]: record }, null, 1), { mode: 0o600 });
  renameSync(temp, file());
  return record;
}
export const licenceAcceptanceFileExists = (): boolean => existsSync(file());
