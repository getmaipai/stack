// UI-22 fills this in with real remote-stack discovery and connection
// state. Until then, no remote stack is ever configured, so the
// selector's "Switch stack" section never renders (spec: "rendered
// only when a remote list exists").
export interface RemoteStack {
  id: string;
  name: string;
  status: "online" | "offline" | "unconfigured";
}

export function useRemoteStacks(): RemoteStack[] {
  return [];
}
