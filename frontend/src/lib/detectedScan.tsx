import { RelativeTime } from "@/kit/ui/relative-time";
import { api } from "@/lib/api";

export type DetectedScan = {
  found: { tools: number; modelFiles: number };
  scannedAt: string | null;
};

export async function scanComputer(): Promise<DetectedScan> {
  return api.post<DetectedScan>("/stack/v1/detected/scan");
}

export function scanSummary(found: DetectedScan["found"]): string {
  if (found.tools === 0 && found.modelFiles === 0) return "Nothing new found";
  const tools = `${found.tools} tool${found.tools === 1 ? "" : "s"}`;
  const modelFiles = `${found.modelFiles} model file${found.modelFiles === 1 ? "" : "s"}`;
  return `Found ${tools} and ${modelFiles}`;
}

export function ScanStatus({ scan }: { scan: DetectedScan | null }) {
  if (!scan) return null;
  return <p className="text-sm text-muted-foreground" role="status">{scanSummary(scan.found)}{scan.scannedAt && <> · Last scan <RelativeTime at={scan.scannedAt} /></>}</p>;
}
