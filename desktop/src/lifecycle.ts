export type LifecycleState = "running" | "agent" | "missing";
export type LifecycleAction = "attach" | "start" | "install";

export function lifecycleAction(state: LifecycleState): LifecycleAction {
  return state === "running" ? "attach" : state === "agent" ? "start" : "install";
}
