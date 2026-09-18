import { execFileSync } from "node:child_process";

export interface ActivityReader {
  secondsSinceInput(): number;
}

function macIdleSeconds(): number {
  try {
    const output = execFileSync("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8", timeout: 1_000 });
    const value = output.match(/HIDIdleTime"\s*=\s*(\d+)/)?.[1];
    return value ? Number(value) / 1_000_000_000 : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function getActivityReader(): ActivityReader {
  return { secondsSinceInput: process.platform === "darwin" ? macIdleSeconds : () => Number.POSITIVE_INFINITY };
}

export function hasRecentActivity(reader: ActivityReader, windowSeconds = 300): boolean {
  return reader.secondsSinceInput() < windowSeconds;
}
