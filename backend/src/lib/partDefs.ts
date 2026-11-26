// The one table of parts: the only place a part's name, description and priority are written (PARTS-STACK-01).
// It imports nothing, so any module can read a label without an import cycle. `parts.ts` builds the full
// StackPart records from it.
import rows from "@/rows/partDefs.json";

export interface PartDef {
  id: string; kind: "model" | "tool" | "engine"; category: string; priority: number; label: string; neutralLabel: string; description: string; adultOnly: boolean; minorOnly?: boolean;
}

export const PART_DEFS: readonly PartDef[] = rows as unknown as readonly PartDef[];

export function partDef(id: string): PartDef | undefined { return PART_DEFS.find((part) => part.id === id); }
export function partLabel(id: string): string { const part = partDef(id); return part ? (part.minorOnly ? part.neutralLabel : part.label) : id; }
