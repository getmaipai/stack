// The admin page's `StackClient` for the shared AI and models page (STACK-MODELS-PAGE-01): one adapter over the same-origin
// `/stack/v1/*` routes, with the session cookie and the CSRF header that `api.ts` already adds. It holds no choice logic and
// no request code of its own: every method is one call through `call` (api.ts), and a refusal becomes the Stack's own sentence.
import { ApiError, call } from "./api";
import { FEED_EVENTS } from "./live";
import { StackClientError } from "@maipai/ui/src/stack/StackClient";
import type {
  StackAddModelBody, StackAddModelResult, StackCategoryId, StackClient, StackInstallStarted, StackLevel, StackOrderBody, StackOrderResult, StackPickBody, StackPickResult,
  StackRecommendedResult, StackRemoveBody, StackRemoveResult, StackRemoved, StackUnused, StackChoicesView,
} from "@maipai/ui/src/stack/StackClient";

const enc = encodeURIComponent;

/** Run one Stack call; a failure is thrown as the page's own error type so it shows the Stack's sentence and keeps its code. */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof ApiError) throw new StackClientError(error.message, error.code);
    throw error;
  }
}

export interface AdminStackClient extends StackClient {
  /** Tell the page its data is stale (an action beside the page, such as applying a setup, changed the choices). */
  changed(): void;
}

/**
 * `onWrite` runs after every successful write (the admin shell uses it to refresh the roles it shows elsewhere).
 * `subscribe` shares one EventSource among every listener and closes it with the last one.
 */
export function createStackClient(onWrite?: () => void): AdminStackClient {
  const listeners = new Set<() => void>();
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { for (const listener of listeners) listener(); }, 250);
  };
  const wrote = <T>(value: T): T => { onWrite?.(); return value; };

  return {
    readChoices: () => run(() => call<StackChoicesView>("GET", "/stack/v1/choices")),
    setRoleEnabled: (role: string, enabled: boolean) => run(async () => { await call("PUT", "/stack/v1/settings", { [`stack.roles.${role}.enabled`]: enabled }); wrote(null); }),
    setRolePriorities: (priorities: Readonly<Record<string, number>>) => run(async () => {
      await call("PUT", "/stack/v1/settings", Object.fromEntries(Object.entries(priorities).map(([role, n]) => [`stack.roles.${role}.priority`, n])));
      wrote(null);
    }),
    chooseModel: (category: StackCategoryId, level: StackLevel, body: StackPickBody) => run(async () => wrote(await call<StackPickResult>("PUT", `/stack/v1/choices/${enc(category)}/${enc(level)}`, body))),
    setOrder: (category: StackCategoryId, body: StackOrderBody) => run(async () => wrote(await call<StackOrderResult>("PUT", `/stack/v1/choices/${enc(category)}/order`, body))),
    recommended: (dryRun: boolean) => run(async () => {
      const result = await call<StackRecommendedResult>("POST", "/stack/v1/choices/recommended", { dry_run: dryRun });
      return dryRun ? result : wrote(result);
    }),
    installModel: (id: string) => run(async () => wrote(await call<StackInstallStarted>("POST", `/stack/v1/parts/${enc(id)}/install`, {}))),
    removeModel: (id: string) => run(async () => wrote(await call<StackRemoved>("DELETE", `/stack/v1/parts/${enc(id)}`))),
    readUnused: () => run(() => call<StackUnused>("GET", "/stack/v1/choices/unused")),
    removeUnused: (body: StackRemoveBody) => run(async () => wrote(await call<StackRemoveResult>("POST", "/stack/v1/choices/unused/remove", body))),
    addModel: (body: StackAddModelBody) => run(async () => wrote(await call<StackAddModelResult>("POST", "/stack/v1/choices/add-model", body))),
    changed: fire,
    subscribe(onChange) {
      listeners.add(onChange);
      if (!source) {
        try {
          source = new EventSource("/stack/v1/events");
          source.onmessage = fire;
          for (const name of FEED_EVENTS) source.addEventListener(name, fire);
        } catch { /* the page still asks again while a download runs */ }
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) { source?.close(); source = null; if (timer) { clearTimeout(timer); timer = null; } }
      };
    },
  };
}
