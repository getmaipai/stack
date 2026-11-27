// Where the admin page can be opened from another computer, said by the Stack itself. The Stack alone knows whether its Tailscale listener is
// up: the setting `stack.admin.tailscale` only takes effect at the next start, and the listener binds nothing when the computer has no Tailscale
// address. Home reads this (`GET /stack/v1/admin-access`) to build its "Open Stack admin" link and keeps no copy of the answer.
import { settingIntent, settingValues } from "@/settings";
import { pickTailscaleAddress } from "@/lib/adminListener";

export type AdminTailscaleState =
  /** The listener is up: `url` is the sign-in page on this computer's tailnet address. */
  | "listening"
  /** The setting is on but the Stack has not been restarted since; `address` is where it will listen. */
  | "restart_pending"
  /** The setting is on and the Stack started with it, but this computer has no Tailscale address, so only loopback is open. */
  | "no_address"
  /** The setting is off. */
  | "off";

export interface AdminAccess {
  tailscale: {
    state: AdminTailscaleState;
    /** The sign-in page over Tailscale; null unless the listener is up. */
    url: string | null;
    /** This computer's tailnet address, when it has one. */
    address: string | null;
    port: number;
    /** One plain sentence saying what is true and what to do next. */
    message: string;
  };
}

const KEY = "stack.admin.tailscale";
let bound: { address: string; port: number } | null = null;

/** The daemon says what it bound at start (null when it bound nothing). */
export function recordTailscaleListener(listener: { address: string; port: number } | null): void { bound = listener; }
export function __resetAdminAccessForTests(): void { bound = null; }

export function adminAccess(address: string | null = pickTailscaleAddress()): AdminAccess {
  const port = bound?.port ?? Number(process.env.PORT ?? settingValues()["stack.runtime.port"] ?? 8770);
  const inEffect = settingValues()[KEY] === true;
  const wanted = settingIntent(KEY) === true;
  if (bound && inEffect) {
    return { tailscale: { state: "listening", url: `http://${bound.address}:${bound.port}/admin/`, address: bound.address, port: bound.port, message: "The admin page opens from any computer on your tailnet. Sign in with the admin password." } };
  }
  if (wanted && !inEffect) {
    return { tailscale: { state: "restart_pending", url: null, address, port, message: "The setting is on and takes effect when the Stack restarts. Restart the Stack, then this link works from any computer on your tailnet." } };
  }
  if (inEffect && address) {
    // The setting took effect but nothing is bound: this computer had no Tailscale address when the Stack started, and has one now.
    return { tailscale: { state: "restart_pending", url: null, address, port, message: "The setting is on, but the Stack is not listening on your tailnet yet. Restart the Stack so it binds this computer's Tailscale address." } };
  }
  if (inEffect) {
    return { tailscale: { state: "no_address", url: null, address: null, port, message: "The setting is on, but this computer has no Tailscale address. Sign in to Tailscale on this computer, then restart the Stack." } };
  }
  return { tailscale: { state: "off", url: null, address, port, message: "Turn on \"Admin page over Tailscale\" in the Stack's settings and restart the Stack to open the admin page from another computer." } };
}
