import type { HardwareInfo } from "@/lib/api";

export function osPlain(osVersion: string): string {
  const major = osVersion.split(".")[0];
  if (major === "") return "macOS";
  return `macOS ${major}`;
}

function platformName(hardware: HardwareInfo): string {
  if (hardware.platform === "darwin" && hardware.isAppleSilicon) return "Apple silicon Mac";
  if (hardware.platform === "darwin") return "Intel Mac";
  if (hardware.platform === "win32") return "Windows computer";
  if (hardware.platform === "linux") return "Linux computer";
  return "This computer";
}

// Same branch as platformName(), so the OS name matches the computer name
// on the line above it rather than assuming every build is macOS.
function osName(hardware: HardwareInfo): string {
  if (hardware.platform === "darwin") return "macOS";
  if (hardware.platform === "win32") return "Windows";
  if (hardware.platform === "linux") return "Linux";
  return hardware.platform;
}

export function plainHardware(hardware: HardwareInfo): string {
  const memory = Math.max(0, Math.round(hardware.isAppleSilicon ? hardware.unifiedMemoryGb : hardware.totalRamGb));
  const freeDisk = Math.max(0, Math.round(hardware.freeDiskBytes / 1_073_741_824));
  return `${platformName(hardware)}, ${memory} GB of memory, ${freeDisk} GB free`;
}

export function plainHardwareDetails(hardware: HardwareInfo): string[] {
  return [
    plainHardware(hardware),
    `${hardware.cpuCount} CPU cores, ${osName(hardware)} ${hardware.osVersion}`,
  ];
}
