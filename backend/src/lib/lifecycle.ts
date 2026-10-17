// Whether the Stack is shutting down. The app answers 503 `stack_restarting`
// with a Retry-After while it is, so a client sees a clean "come back in a
// moment" and not a dropped connection.
let stopping = false;
export function beginStopping(): void { stopping = true; }
export function isStopping(): boolean { return stopping; }
export function __resetLifecycleForTests(): void { stopping = false; }
