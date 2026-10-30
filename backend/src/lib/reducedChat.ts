export type ReducedChatState = "off" | "entering" | "reduced" | "leaving";

let state: ReducedChatState = "off";
let roleModels = new Map<string, string>();

export function getReducedChatState(): ReducedChatState { return state; }
export function reducedChatForcesLight(): boolean { return state === "entering" || state === "reduced"; }
export function setReducedChatState(next: ReducedChatState): void { state = next; }
export function reducedChatModels(): Map<string, string> { return new Map(roleModels); }
export function setReducedChatModels(models: Map<string, string>): void { roleModels = new Map(models); }
export function resetReducedChatForTests(): void { state = "off"; roleModels.clear(); }
