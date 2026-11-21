// Which address the optional Tailscale listener binds. Pure so a test can
// feed it any interface table: it returns one IPv4 inside 100.64.0.0/10
// (the range Tailscale hands out) from an interface that is not the
// loopback, and nothing else. It never answers 0.0.0.0, a LAN address
// (10.x, 172.16.x, 192.168.x) or an IPv6 address, so the Stack cannot be
// opened to the home network by this path.
import { networkInterfaces } from "node:os";

type Interfaces = ReturnType<typeof networkInterfaces>;

/** True for an IPv4 address in 100.64.0.0/10 (100.64.0.0 to 100.127.255.255). */
export function isTailscaleAddress(address: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((part) => part > 255)) return false;
  return a === 100 && b >= 64 && b <= 127;
}

/** The first Tailscale IPv4 address among the interfaces, or null. */
export function pickTailscaleAddress(interfaces: Interfaces = networkInterfaces()): string | null {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = String(entry.family);
      if (family !== "IPv4" && family !== "4") continue;
      if (entry.internal) continue;
      if (isTailscaleAddress(entry.address)) return entry.address;
    }
  }
  return null;
}
