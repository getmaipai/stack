import { execFile } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

export interface NetworkSignal {
  interface: string | null;
  linkMbps: number | null;
  gatewayMs: number | null;
  measuredAt: string;
}

type ExecFileResult = { stdout: string; stderr: string };

export interface NetworkReaders {
  routeGet: () => Promise<ExecFileResult>;
  procNetRoute: () => Promise<string>;
  ifconfig: (iface: string) => Promise<ExecFileResult>;
  sysClassNetSpeed: (iface: string) => Promise<string>;
  gatewayConnect: (gateway: string, timeoutMs: number) => Promise<number | null>;
}

const execFileAsync = promisify(execFile);

function tcpConnectMs(gateway: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = connect({ host: gateway, port: 80, timeout: timeoutMs });
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(Date.now() - startedAt));
    socket.once("timeout", () => finish(null));
    // A refused connection still completed the round trip to the gateway.
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED" ? Date.now() - startedAt : null));
  });
}

const defaultReaders: NetworkReaders = {
  routeGet: () => execFileAsync("route", ["-n", "get", "default"], { timeout: 2_000 }),
  procNetRoute: () => readFile("/proc/net/route", "utf8"),
  ifconfig: (iface: string) => execFileAsync("ifconfig", [iface], { timeout: 2_000 }),
  sysClassNetSpeed: (iface: string) => readFile(`/sys/class/net/${iface}/speed`, "utf8"),
  gatewayConnect: tcpConnectMs,
};

let readers: NetworkReaders = defaultReaders;

export function __setNetworkReadersForTests(next: Partial<NetworkReaders>): void {
  readers = { ...defaultReaders, ...next };
}

export function __resetNetworkReadersForTests(): void {
  readers = defaultReaders;
}

let cached: NetworkSignal | null = null;
let cachedAtMs = 0;
const CACHE_MS = 30_000;

export function __resetNetworkCacheForTests(): void {
  cached = null;
  cachedAtMs = 0;
}

function parseMacRouteGet(output: string): { interface: string | null; gateway: string | null } {
  const interfaceMatch = output.match(/^\s*interface:\s*(\S+)/m);
  const gatewayMatch = output.match(/^\s*gateway:\s*(\S+)/m);
  return { interface: interfaceMatch?.[1] ?? null, gateway: gatewayMatch?.[1] ?? null };
}

function hexToIPv4(hex: string): string | null {
  if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
  const bytes = [0, 2, 4, 6].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  // /proc/net/route stores the address little-endian.
  return bytes.reverse().join(".");
}

function parseLinuxRoute(output: string): { interface: string | null; gateway: string | null } {
  const lines = output.trim().split("\n");
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    const iface = fields[0];
    const destination = fields[1];
    const gatewayHex = fields[2];
    if (iface && destination === "00000000" && gatewayHex) {
      const gateway = hexToIPv4(gatewayHex);
      return { interface: iface, gateway: gateway && gateway !== "0.0.0.0" ? gateway : null };
    }
  }
  return { interface: null, gateway: null };
}

async function defaultRoute(): Promise<{ interface: string | null; gateway: string | null }> {
  if (process.platform === "darwin") {
    const result = await readers.routeGet().catch(() => null);
    return result ? parseMacRouteGet(result.stdout) : { interface: null, gateway: null };
  }
  const output = await readers.procNetRoute().catch(() => null);
  return output ? parseLinuxRoute(output) : { interface: null, gateway: null };
}

function parseMacLinkMbps(ifconfigOutput: string): number | null {
  const mediaLine = ifconfigOutput.match(/^\s*media:.*$/m)?.[0] ?? "";
  const baseMatch = mediaLine.match(/(\d+)base/);
  if (!baseMatch) return null;
  const mbps = Number(baseMatch[1]);
  return Number.isFinite(mbps) && mbps > 0 ? mbps : null;
}

function parseLinuxLinkMbps(speedOutput: string): number | null {
  const mbps = Number(speedOutput.trim());
  return Number.isFinite(mbps) && mbps > 0 ? mbps : null;
}

async function linkSpeedFor(iface: string): Promise<number | null> {
  if (process.platform === "darwin") {
    const result = await readers.ifconfig(iface).catch(() => null);
    return result ? parseMacLinkMbps(result.stdout) : null;
  }
  const output = await readers.sysClassNetSpeed(iface).catch(() => null);
  return output ? parseLinuxLinkMbps(output) : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2) : (sorted[mid] ?? null);
}

async function gatewayLatencyMs(gateway: string): Promise<number | null> {
  const samples = await Promise.all([1, 2, 3].map(() => readers.gatewayConnect(gateway, 1_000)));
  const measured = samples.filter((sample): sample is number => sample !== null);
  return median(measured);
}

async function measureNetworkSignal(): Promise<NetworkSignal> {
  const { interface: iface, gateway } = await defaultRoute();
  const [linkMbps, gatewayMs] = await Promise.all([
    iface ? linkSpeedFor(iface) : Promise.resolve(null),
    gateway ? gatewayLatencyMs(gateway) : Promise.resolve(null),
  ]);
  return { interface: iface, linkMbps, gatewayMs, measuredAt: new Date().toISOString() };
}

export async function readNetworkSignal(): Promise<NetworkSignal> {
  const now = Date.now();
  if (cached && now - cachedAtMs < CACHE_MS) return cached;
  const signal = await measureNetworkSignal();
  cached = signal;
  cachedAtMs = now;
  return signal;
}
