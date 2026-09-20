// sd_notify without libsystemd: the READY, WATCHDOG and STOPPING
// datagrams a `Type=notify` unit with `WatchdogSec` expects, sent to
// $NOTIFY_SOCKET over an AF_UNIX SOCK_DGRAM socket through bun:ffi.
// A no-op wherever systemd is not the parent (no NOTIFY_SOCKET), so the
// same daemon runs under launchd or a shell unchanged.
export type NotifyState = "READY=1" | "WATCHDOG=1" | "STOPPING=1";
export type NotifySender = (socketPath: string, message: string) => boolean;

const AF_UNIX = 1;
const SOCK_DGRAM = 2;

let sender: NotifySender | null = null;

function ffiSender(): NotifySender {
  return (socketPath, message) => {
    // Linux only: the sockaddr_un layout below is Linux's (family u16,
    // path 108 bytes), and macOS never sets NOTIFY_SOCKET.
    if (process.platform !== "linux") return false;
    try {
      // Dynamic import keeps the FFI out of every other platform's load.
      const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
      const libc = dlopen("libc.so.6", {
        socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        sendto: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i64 },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
      });
      const fd = libc.symbols.socket(AF_UNIX, SOCK_DGRAM, 0);
      if (fd < 0) return false;
      const address = new Uint8Array(110);
      address[0] = AF_UNIX & 0xff; address[1] = (AF_UNIX >> 8) & 0xff;
      const path = new TextEncoder().encode(socketPath.startsWith("@") ? `\0${socketPath.slice(1)}` : socketPath);
      // sockaddr_un holds 108 path bytes; a longer path is refused, never
      // truncated to a socket that is not the one systemd named.
      if (path.length > 107) { libc.symbols.close(fd); return false; }
      address.set(path, 2);
      const bytes = new TextEncoder().encode(message);
      const sent = libc.symbols.sendto(fd, ptr(bytes), BigInt(bytes.length), 0, ptr(address), 2 + path.length);
      libc.symbols.close(fd);
      return Number(sent) === bytes.length;
    } catch { return false; }
  };
}

/** Sends one state; true when systemd is listening and took it. */
export function notifySystemd(state: NotifyState): boolean {
  const socketPath = process.env.NOTIFY_SOCKET;
  if (!socketPath) return false;
  return (sender ?? ffiSender())(socketPath, `${state}\n`);
}

/** Answers the unit's WatchdogSec at half the interval systemd
 * announced in WATCHDOG_USEC; returns a stop function. A no-op when
 * systemd announced no watchdog. */
export function startSystemdWatchdog(): () => void {
  const usec = Number(process.env.WATCHDOG_USEC ?? 0);
  if (!process.env.NOTIFY_SOCKET || !(usec > 0)) return () => {};
  const timer = setInterval(() => { notifySystemd("WATCHDOG=1"); }, Math.max(1_000, Math.floor(usec / 2000)));
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

export function __setNotifySenderForTests(next: NotifySender | null): void { sender = next; }
