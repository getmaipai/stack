// 2026-10-26: macOS stopped answering the Metal shader compiler (launchd
// logged thousands of "denied lookup com.apple.MTLCompilerService"), so every
// Metal engine failed to start while memory was 94% free. Before a Metal
// engine launches, the Stack compiles one tiny shader; a host that cannot is
// reported as a host fault, which self-heal waits out instead of retrying.
import { METAL_COMPILER_SENTENCE } from "@/lib/crashClassifier";

export const METAL_ENGINES = ["llama-server", "mlx-serve", "omlx", "splash"];
const PROBE_TIMEOUT_MS = 10_000;

/** Returns null when the host compiled the shader (or could not be asked), else the reason it did not. */
export type MetalProbe = () => Promise<string | null>;

// JXA: one Metal compile through the same compiler service the engines use. The nonce keeps the compile from being answered by Metal's cache.
const script = (nonce: number): string => `ObjC.import('Metal');
var d = $.MTLCreateSystemDefaultDevice();
if (!d || d.isNil()) { console.log('NODEVICE'); } else {
  var e = Ref();
  var lib = d.newLibraryWithSourceOptionsError('// ${nonce}\\nkernel void k(device float *a [[buffer(0)]], uint i [[thread_position_in_grid]]) { a[i] = a[i] + 1.0; }', $(), e);
  console.log((!lib || lib.isNil()) ? 'FAIL ' + ObjC.unwrap(e[0].localizedDescription) : 'OK');
}`;

const realProbe: MetalProbe = async () => {
  if (process.platform !== "darwin") return null;
  try {
    const child = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", script(Date.now())], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    await child.exited;
    clearTimeout(timer);
    return /^FAIL|MTLCompilerService/m.test(out) || /MTLCompilerService/.test(err) ? METAL_COMPILER_SENTENCE : null;
  } catch { return null; }
};

let probe: MetalProbe = realProbe;
export function setMetalProbeForTests(next: MetalProbe | null): void { probe = next ?? realProbe; }

/** The plain reason a Metal engine cannot start on this host right now, or null. */
export function metalHostFault(engine: string): Promise<string | null> {
  return METAL_ENGINES.includes(engine) ? probe() : Promise.resolve(null);
}
