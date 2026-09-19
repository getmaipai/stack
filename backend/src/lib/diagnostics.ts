import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../../package.json";
import { list as listHealth } from "@/lib/health";
import { detectHardware } from "@/lib/hardware";
import { redactLogText } from "@/lib/log";
import { dataDir } from "@/lib/paths";
import { readStackConfig } from "@/settings/stackKeys";

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array { return Uint8Array.of(value & 255, (value >>> 8) & 255); }
function u32(value: number): Uint8Array { return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255); }
function concat(parts: Uint8Array[]): Uint8Array { const length = parts.reduce((total, part) => total + part.length, 0); const result = new Uint8Array(length); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }

// Stored ZIP entries keep this small support file portable without adding a runtime dependency.
function zip(entries: Array<{ name: string; text: string }>): Uint8Array {
  const locals: Uint8Array[] = []; const central: Uint8Array[] = []; let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name); const body = encoder.encode(entry.text); const crc = crc32(body);
    const local = concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(body.length), u32(body.length), u16(name.length), u16(0), name, body]);
    locals.push(local);
    central.push(concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(body.length), u32(body.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += local.length;
  }
  const directory = concat(central);
  return concat([...locals, directory, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(directory.length), u32(offset), u16(0)]);
}

function recentLogLines(): string[] {
  const path = join(dataDir, "logs", "stack.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-100).map(redactLogText);
}

export async function diagnosticsBundle(): Promise<Uint8Array> {
  const { computerName: _computerName, ...hardware } = await detectHardware();
  const settings = readStackConfig().filter((setting) => !["secret", "password"].includes(String(setting.type)));
  return zip([
    { name: "logs/stack.log", text: recentLogLines().join("\n") },
    { name: "health.json", text: JSON.stringify(listHealth(), null, 2) },
    { name: "hardware.json", text: JSON.stringify(hardware, null, 2) },
    { name: "settings.json", text: JSON.stringify(settings, null, 2) },
    { name: "versions.json", text: JSON.stringify({ stack: packageJson.version, bun: Bun.version, platform: process.platform, arch: process.arch }, null, 2) },
  ]);
}
