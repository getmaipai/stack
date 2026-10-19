export function engineRemovalRefusal(input: {
  isCurrent: boolean;
  hasCurrent: boolean;
  roleRunning: boolean;
  bound: boolean;
}): string | null {
  if (input.isCurrent && input.roleRunning) {
    return "This engine build is serving a role right now. Stop the role first, then remove the build.";
  }
  if (input.bound && !input.hasCurrent) {
    return "A model still names this engine. Install or select another build first.";
  }
  return null;
}
