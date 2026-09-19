type DialogApi = { open(options?: { directory?: boolean; multiple?: boolean; title?: string }): Promise<string | string[] | null> };
type NotificationApi = { sendNotification(options: { title: string; body?: string }): Promise<void> | void };
type AutostartApi = { enable(): Promise<void>; disable(): Promise<void>; isEnabled(): Promise<boolean> };
type TraySnapshot = { signedIn: boolean; status?: "Running" | "Paused" | "Starting" | "Stopped"; severity?: "critical" | "error" | "warning" | "ok" };
type TauriEvent<T> = { payload: T };
type TauriGlobals = {
  dialog?: DialogApi;
  notification?: NotificationApi;
  autostart?: AutostartApi;
  core?: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event?: { listen<T>(event: string, handler: (event: TauriEvent<T>) => void): Promise<() => void> };
};

function tauri(): TauriGlobals | null {
  const value = (globalThis as typeof globalThis & { __TAURI__?: TauriGlobals }).__TAURI__;
  return value ?? null;
}

export function isDesktop(): boolean {
  return typeof window !== "undefined" && tauri() !== null;
}

async function pick(options: { directory?: boolean; title?: string }): Promise<string | null> {
  const dialog = tauri()?.dialog;
  if (!dialog) return null;
  const selected = await dialog.open({ ...options, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export function pickFolder(): Promise<string | null> { return pick({ directory: true, title: "Choose a model folder" }); }
export function pickFile(): Promise<string | null> { return pick({ title: "Choose a file" }); }

export async function notify(title: string, body?: string): Promise<void> {
  await tauri()?.notification?.sendNotification({ title, body });
}

export async function launchAtLoginEnabled(): Promise<boolean> {
  return tauri()?.autostart?.isEnabled() ?? false;
}

export async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  const autostart = tauri()?.autostart;
  if (!autostart) return;
  if (enabled) await autostart.enable();
  else await autostart.disable();
}

export async function setTraySnapshot(snapshot: TraySnapshot): Promise<void> {
  await tauri()?.core?.invoke("set_tray_state", { snapshot });
}

export async function listenForTrayAction(handler: (action: "toggle") => void): Promise<() => void> {
  const events = tauri()?.event;
  if (!events) return () => undefined;
  return events.listen<"toggle">("tray-action", (event) => handler(event.payload));
}
