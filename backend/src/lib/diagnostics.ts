// The Stack's diagnostics bundle for Home's support flow: a stored ZIP
// (core's writer) of the redacted log tail, the health list, the
// hardware facts without the computer name, the settings and versions.
// Nothing here is sent anywhere; Home hands the bytes to the person.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createZipArchive } from "@maipai/core/src/zip";
import packageJson from "../../package.json";
import { list as listHealth } from "@/lib/health";
import { detectHardware } from "@/lib/hardware";
import { logger } from "@/lib/log";
import { logsDir } from "@/lib/paths";
import { readSettings } from "@/settings";

function recentLogLines(): string[] {
  const path = join(logsDir, "stack.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-200).map((line) => logger.redact(line));
}

export async function diagnosticsBundle(): Promise<Uint8Array> {
  const { computerName: _computerName, ...hardware } = await detectHardware();
  return createZipArchive([
    { name: "logs/stack.log", text: recentLogLines().join("\n") },
    { name: "health.json", text: JSON.stringify(listHealth(), null, 2) },
    { name: "hardware.json", text: JSON.stringify(hardware, null, 2) },
    { name: "settings.json", text: JSON.stringify(readSettings(), null, 2) },
    { name: "versions.json", text: JSON.stringify({ stack: packageJson.version, bun: Bun.version, platform: process.platform, arch: process.arch }, null, 2) },
  ]);
}
