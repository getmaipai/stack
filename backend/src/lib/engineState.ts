export interface EngineVersionInputs {
  running: string | null;
  currentTag: string | null;
  newestTag: string | null;
  needsRestart: boolean;
}

export interface EngineVersionState extends EngineVersionInputs {
  current: boolean;
  notCurrent: boolean;
  state: "current" | "notCurrent";
  stateReason: "newer installed" | "newer available" | null;
}

export function deriveEngineVersionState(inputs: EngineVersionInputs): EngineVersionState {
  const newerInstalled = inputs.running !== null && inputs.currentTag !== null && !inputs.running.includes(inputs.currentTag);
  const newerAvailable = !newerInstalled && inputs.currentTag !== null && inputs.newestTag !== null && inputs.currentTag !== inputs.newestTag;
  const notCurrent = newerInstalled || newerAvailable;
  return { ...inputs, current: !notCurrent, notCurrent, state: notCurrent ? "notCurrent" : "current", stateReason: newerInstalled ? "newer installed" : newerAvailable ? "newer available" : null };
}
