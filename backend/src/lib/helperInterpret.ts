// Reads an admin's message before the model does and turns the plain cases into a precise plan: which read
// tools to run first (so the model only has to put real facts into plain words), which typed action the
// message asks for, or which sentence to say (a question when the words fit two features, a refusal for what
// the Helper does not do). Anything it does not recognise falls through to the model and its tools.
// Pure: no network, no model. tests/helperInterpret.test.ts pins it.
import { PRIMARY_ROLE } from "@/roles";
import { GLOSSARY, resolveRole, termsIn, TIER_NAMES, type Topic } from "@/lib/helperKnowledge";
import type { RoleId } from "@/roles";

export interface PlannedRead { name: string; args: Record<string, unknown> }
export interface PlannedAction { action: string; params: Record<string, unknown> }
export interface Plan {
  reads: PlannedRead[];
  action?: PlannedAction;
  /** A fixed sentence to say instead of asking the model (a clarifying question or a refusal). */
  say?: string;
}

const FILLER = /^(please|can you|could you|would you|will you|i want you to|i'd like you to|i would like you to|go ahead and|just|hey|ok|okay|helper)[,\s]+/;
const ARTICLE = /^(the|my|our|a|an)\s+/;
const stripNoun = (s: string): string => {
  let t = s.trim().replace(/[.!?]+$/, "").replace(/\s+for me$/, "").replace(/\s+please$/, "");
  for (let i = 0; i < 3; i++) t = t.replace(ARTICLE, "");
  return t.replace(/\s+(feature|role|function|engine|mode)$/, "").replace(/^(the\s+)?(feature|role)\s+/, "").trim();
};
const clean = (message: string): string => {
  let t = message.toLowerCase().trim().replace(/[.!]+$/, "");
  for (let i = 0; i < 3; i++) t = t.replace(FILLER, "");
  return t.replace(/\s+(for me|please|now|thanks|thank you)$/, "").replace(/\s+(for me|please)$/, "").trim();
};

type Target = { ok: true; role: RoleId } | { ok: false; say: string | null };
/** "it" leans on the last feature talked about; words that fit two features become a question. */
function target(noun: string, previous: Topic | null, what: string): Target {
  const n = stripNoun(noun);
  if (/^(it|that|this|that one|this one)$/.test(n)) return previous?.role ? { ok: true, role: previous.role } : { ok: false, say: `Which feature should I ${what}? For example Video, Music or Images.` };
  const r = resolveRole(n);
  if (r.ok) return { ok: true, role: r.role };
  // Words that fit two features become a question; words that fit none are left to the model.
  return { ok: false, say: r.options ? `${r.reason} Which one do you mean?` : null };
}

const REBOOT = /\b(reboot|restart|shut ?down|power off|power cycle)\b.*\b(computer|pc|laptop|mac|macbook|machine|studio|mac mini)\b/;
const REMOVE = /\b(delete|remove|uninstall|erase|wipe|get rid of)\b.*\b(model|models|weights|27b|qwen|file|files|engine)\b/;
const SECRET = /\b(password|passcode|token|api key|secret|credential)s?\b/;

/** Words that make a message a definition question ("what is", "what does ... mean", "explain"). */
const DEFINITION = /^(what('s| is| are| does)|whats|explain|define|tell me about|what do you mean by|how does)\b|^(is|are)\s+[\w-]+\s+(a|an)\b|\b(mean|means|meaning)\b|\bdifference between\b/;
const MEMORY_Q = /\b(memory|ram|taking so much|using so much|so much memory|how much .*(use|using|take|taking|hold|holding))\b/;

export function interpret(message: string, previous: Topic | null): Plan {
  const t = clean(message);
  const reads: PlannedRead[] = [];
  const add = (name: string, args: Record<string, unknown> = {}) => { if (!reads.some((r) => r.name === name && JSON.stringify(r.args) === JSON.stringify(args))) reads.push({ name, args }); };

  // Not offered at all.
  if (REBOOT.test(t) || /^(reboot|shut ?down)\b/.test(t)) return { reads, say: "I cannot restart or shut down the computer. Use the Tools screen for that." };
  if (REMOVE.test(t)) return { reads, say: "I do not remove models or engines. Use the AI and models screen to remove a model." };
  if (SECRET.test(t) && /\b(what|show|print|tell|read|give|reveal|change|reset|set)\b/.test(t)) return { reads, say: "I cannot read or change passwords or tokens. Use the sign-in settings on this computer." };

  // Changes. One typed action when the words are clear; a question when they fit two features.
  const toModel: Plan = { reads };
  const stop = (who: { ok: false; say: string | null }): Plan => (who.say ? { reads, say: who.say } : toModel);
  const bareOnOff = /^(turn|switch)\s+(on|off)$/.exec(t);
  if (bareOnOff) return { reads, say: `Which feature should I turn ${bareOnOff[2]}? For example Video, Music or Images.` };
  const leading = /^(?:turn|switch)\s+(on|off)\s+(.+)$/.exec(t);
  const trailing = /^(?:turn|switch|set)\s+(.+?)\s+(on|off)$/.exec(t);
  const verb = /^(enable|disable|activate|deactivate)\s+(.+)$/.exec(t);
  if (leading || trailing || verb) {
    const noun = leading ? leading[2]! : trailing ? trailing[1]! : verb![2]!;
    const state = leading ? leading[1] === "on" : trailing ? trailing[2] === "on" : /^(enable|activate)$/.test(verb![1]!);
    const who = target(noun, previous, state ? "turn on" : "turn off");
    if (!who.ok) return stop(who);
    return { reads, action: { action: "set_role_enabled", params: { role: who.role, enabled: state } } };
  }
  const move = /^(?:move|put|place|rank|set)\s+(.+?)\s+(above|before|over|ahead of|below|after|under|behind)\s+(.+)$/.exec(t);
  if (move) {
    const who = target(move[1]!, previous, "move");
    if (!who.ok) return stop(who);
    const other = target(move[3]!, previous, "compare it with");
    if (!other.ok) return stop(other);
    const above = /^(above|before|over|ahead of)$/.test(move[2]!);
    return { reads, action: { action: "set_role_priority", params: { role: who.role, [above ? "above" : "below"]: other.role } } };
  }
  const prio = /^(?:set|change|make|put)\s+(.+?)\s+priority\s+(?:to|at|=)?\s*(\d{1,4})$/.exec(t) ?? /^(?:set|change|make)\s+(?:the\s+)?priority\s+of\s+(.+?)\s+(?:to|at)\s+(\d{1,4})$/.exec(t);
  if (prio) {
    const who = target(prio[1]!, previous, "change");
    if (!who.ok) return stop(who);
    return { reads, action: { action: "set_role_priority", params: { role: who.role, priority: Number(prio[2]) } } };
  }
  if (/^restart\s+(the\s+)?(stack|service|daemon)$/.test(t) || /^restart the maipai stack$/.test(t)) return { reads, action: { action: "restart_stack", params: {} } };
  const restart = /^(?:restart|reload)\s+(.+)$/.exec(t);
  if (restart) {
    const noun = stripNoun(restart[1]!);
    if (noun && !/^(everything|all)$/.test(noun)) {
      const named = resolveRole(noun);
      if (!named.ok && named.options) return { reads, say: `${named.reason} Which one do you mean?` };
      return { reads, action: { action: "restart_engine", params: { name: noun } } };
    }
  }
  if (/^(check|look)\s+(for\s+)?(any\s+)?(new\s+|newer\s+)?updates?$/.test(t) || /^check if there (is|are) (an? )?(new )?updates?$/.test(t)) return { reads, action: { action: "check_updates", params: {} } };
  if (/^(apply|use|set up|switch to|do)\s+(the\s+)?(recommended|custom recommended|suggested|best)\s+(profile|setup|settings|plan)/.test(t)) return { reads, action: { action: "apply_profile", params: { mode: "custom_recommended" } } };
  if (/^(apply|use)\s+(the\s+)?matched\s+(profile|setup)/.test(t)) return { reads, action: { action: "apply_profile", params: { mode: "matched" } } };

  // Questions: run the reads that answer them, so the model only words real facts.
  const topic = termsIn(t);
  if (/\bvoice (engine|model)\b/.test(t) && !topic.role) topic.role = "tts";
  const isDefinition = DEFINITION.test(t);
  const bare = t.replace(/[?]+$/, "").split(/\s+/).length <= 3;
  const followUp = /^(and|what about|how about|what of|same for|then)\b/.test(t) || (bare && !isDefinition && !!(topic.tier || topic.role || topic.engine));
  const role: RoleId | undefined = topic.role ?? (followUp ? previous?.role : undefined);
  const askModels = /\b(model|models|tier|tiers|levels?|chosen|installed|using|use|uses|run|runs|serve|serves|engine)\b/.test(t) || followUp;

  if (topic.engine && isDefinition) add("explain", { term: topic.engine });
  else if (topic.engine && (MEMORY_Q.test(t) || /\b(extra|cache|headroom|room)\b/.test(t))) add("get_engine_use", { name: topic.engine });
  else if (role && askModels) add("get_models", { role, ...(topic.tier ? { tier: topic.tier } : {}) });
  else if (role && /\b(priority|on|off|enabled|disabled|turned|running|working|up|status|state|offline|down)\b/.test(t)) add("get_roles");
  else if (followUp && topic.tier) add("explain", { term: topic.tier });

  if (reads.length === 0) {
    const terms = GLOSSARY.filter((g) => g.words.some((w) => new RegExp(`\\b${w.replace(/[-.]/g, "\\$&")}\\b`).test(t)));
    if (isDefinition && terms.length > 0) {
      if (/\bdifference between\b/.test(t)) for (const term of ["role", "engine", "model"]) add("explain", { term });
      else if (topic.tier) add("explain", { term: topic.tier });
      else if (/\btiers?\b|\blevels?\b/.test(t)) for (const n of ["tier", ...TIER_NAMES]) add("explain", { term: n });
      else for (const g of terms.slice(0, 2)) add("explain", { term: g.term });
    } else if (MEMORY_Q.test(t) && /\b(have|total|installed)\b/.test(t) && /\b(this|computer|mac|machine)\b/.test(t)) add("get_hardware");
    else if (MEMORY_Q.test(t) && !/\b(set|change)\b/.test(t)) add("get_memory");
    else if (/\b(healthy|health|problem|problems|wrong|broken|repair|repairs|issue|issues)\b/.test(t)) add("get_health");
    else if (/\bupdates?\b|\bnewer\b|\bout of date\b/.test(t)) add("get_updates");
    else if (/\b(chip|cpu|gpu|hardware|disk|storage|kind of (computer|mac)|what computer|apple silicon)\b/.test(t)) add("get_hardware");
    else if (/\b(features|roles)\b/.test(t) || /\b(switched|turned|which)\b.*\b(on|off)\b/.test(t)) add("get_roles", { focus: "onoff" });
    else if (/\blogs?\b|\berrors?\b/.test(t)) add("get_logs", { tail: 50 });
    else if (/\b(model|models)\b/.test(t) && /\b(which|what)\b/.test(t)) add("get_models", { role: PRIMARY_ROLE });
  }
  return { reads };
}
