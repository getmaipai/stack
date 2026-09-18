export interface IntentFacts {
  engines: number;
  models: number;
  clients: number;
  chatReady: boolean;
  updates: number;
  modelStorageBytes: number;
}

export interface IntentAnswer {
  id: string;
  sentence: string;
  href: string;
}

interface Intent {
  id: string;
  patterns: RegExp[];
  answer: (facts: IntentFacts) => IntentAnswer;
}

const hits: Record<string, number> = {};
const intents: Intent[] = [
  { id: "engine-count", patterns: [/how many engines/i, /number of engines/i, /engine count/i], answer: (facts) => ({ id: "engine-count", sentence: `${facts.engines} engine${facts.engines === 1 ? "" : "s"} need attention or are available.`, href: "/engines" }) },
  { id: "model-count", patterns: [/how many models/i, /number of models/i, /model count/i], answer: (facts) => ({ id: "model-count", sentence: `${facts.models} model${facts.models === 1 ? "" : "s"} are installed.`, href: "/models" }) },
  { id: "chat-ready", patterns: [/is chat ready/i, /is chat up/i, /chat status/i], answer: (facts) => ({ id: "chat-ready", sentence: facts.chatReady ? "Chat is ready on this computer." : "Chat is not ready on this computer.", href: "/engines" }) },
  { id: "updates", patterns: [/are my models up to date/i, /anything out of date/i, /available updates/i], answer: (facts) => ({ id: "updates", sentence: facts.updates ? `${facts.updates} update${facts.updates === 1 ? "" : "s"} are available.` : "Everything is up to date.", href: "/settings#updates" }) },
  { id: "model-storage", patterns: [/how much disk do models use/i, /model disk usage/i, /model storage/i], answer: (facts) => ({ id: "model-storage", sentence: `Models use ${formatBytes(facts.modelStorageBytes)} of disk space.`, href: "/models" }) },
];

function formatBytes(value: number): string {
  if (!value) return "no measured disk space";
  if (value >= 1_000_000_000) return `${Math.round(value / 1_000_000_000 * 10) / 10} GB`;
  return `${Math.round(value / 1_000_000 * 10) / 10} MB`;
}

export function answerIntent(query: string, facts: IntentFacts): IntentAnswer | null {
  const intent = intents.find((candidate) => candidate.patterns.some((pattern) => pattern.test(query)));
  if (!intent) return null;
  hits[intent.id] = (hits[intent.id] ?? 0) + 1;
  console.info("palette.intent", { id: intent.id, hits: hits[intent.id] });
  return intent.answer(facts);
}

export function intentHits(): Readonly<Record<string, number>> { return hits; }
export function declaredIntents(): readonly string[] { return intents.map((intent) => intent.id); }
