// Checks Home's single-use adult-lock ticket for a LoRA lowering. Fails closed: anything but a clean 200 { ok: true } is a refusal.
import { HOME_TOKEN_HEADER, homeViewToken } from "@/lib/adultView";
import { setAdultTicketVerifier, type AdultTicketVerifier } from "@/lib/media/loraCatalog";

const TIMEOUT_MS = 5000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function createHomeTicketVerifier(options: { baseUrl: string; token: string; fetchFn?: typeof fetch; timeoutMs?: number }): AdultTicketVerifier {
  const doFetch = options.fetchFn ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  return async (ticket, loraId) => {
    try {
      const response = await doFetch(`${base}/api/stack/adult-ticket/consume`, {
        method: "POST",
        headers: { "content-type": "application/json", [HOME_TOKEN_HEADER]: options.token },
        body: JSON.stringify({ ticket, item: loraId }),
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
      if (response.status !== 200) return false;
      const body = (await response.json()) as unknown;
      return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
    } catch { return false; }
  };
}

/** True when the value is an http(s) URL on this computer's loopback; anything else is refused. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname);
  } catch { return false; }
}

/** Reads STACK_HOME_CALLBACK_URL; unset or not loopback leaves no verifier, so lowering stays refused. Returns whether one was installed. */
export function installHomeTicketVerifierFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.STACK_HOME_CALLBACK_URL?.trim();
  if (!value || !isLoopbackUrl(value)) return false;
  setAdultTicketVerifier(createHomeTicketVerifier({ baseUrl: value, token: homeViewToken() }));
  return true;
}
