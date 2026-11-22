// The words and facts a model carries on the choices page, derived in one place so the admin page and Home never print a raw catalog field:
// a plain quantization, the version as people say it, the smallest computer it is offered on, and one searchable string.
import { CHOICE_PROFILES, type ChoiceProfile } from "@/lib/choicesStore";
import { PROFILE_TIERS } from "@/profiles";

/** A tier-table model that is not a part yet (no pinned download), so it has no part row to carry its words. */
export const NOT_YET_PARTS: Record<string, { label: string; summary: string }> = {
  "chatterbox-nano": { label: "Chatterbox Nano", summary: "A smaller version of the Chatterbox voice that needs less memory; it cannot be installed yet." },
};

/** The raw quantization tag in plain words, for people. The raw tag is always kept beside it. */
export function plainQuantization(raw: string | null): string | null {
  if (!raw) return null;
  const tag = raw.toLowerCase();
  if (/run 8-bit/.test(tag)) return "Full-quality files, run as 8-bit to save memory";
  if (/bf16|fp16|\bf16/.test(tag)) return "16-bit, full quality";
  if (/fp32/.test(tag)) return "32-bit, full quality";
  if (/q8|int8|8-bit|8bit/.test(tag)) return "8-bit, near full quality";
  if (/q6/.test(tag)) return "6-bit, high quality";
  if (/q5/.test(tag)) return "5-bit, high quality";
  if (/iq4|q4|4bit|4-bit/.test(tag)) return /xs/.test(tag) ? "4-bit, extra compact" : "4-bit, compact";
  if (/q3|iq3/.test(tag)) return "3-bit, very compact";
  return raw;
}

/** The quantization tag a file name or model id carries (`Q4_K_M`, `IQ4_XS`, `bf16`), when the catalog row names none. */
export function quantizationFromName(name: string): string | null {
  const found = /(?:^|[-_.])(ud-)?((?:i?q\d(?:[-_][a-z0-9]+)*)|bf16|fp16|f16|\d+bit)(?:$|[-_.])/i.exec(name.replace(/\.gguf$/i, ""));
  return found ? `${found[1] ? "UD-" : ""}${found[2]}`.replace(/-/g, "_").toUpperCase() : null;
}

/** The model version as people say it ("3.8"), from the display name first, then the family. Null when the name carries none. */
export function versionOf(label: string, family: string | null): string | null {
  const dotted = /(\d+(?:\.\d+)+)/.exec(label);
  if (dotted) return dotted[1]!;
  const inFamily = /(\d+(?:\.\d+)*)/.exec(family ?? "");
  return inFamily ? inFamily[1]! : null;
}

export function profileMemoryGb(profile: ChoiceProfile): number { return PROFILE_TIERS.find((tier) => tier.id === profile)!.minUnifiedGb; }

/** The smallest profile a model is offered on, as the id and in plain words. */
export function minProfile(profiles: readonly string[]): { id: ChoiceProfile; plain: string } | null {
  const id = CHOICE_PROFILES.find((profile) => profiles.includes(profile));
  return id ? { id, plain: `A ${profileMemoryGb(id)} GB computer or bigger` } : null;
}

/** The fields a page can search, joined and lowercased: label, id, repo, family, version, quantization (plain and raw), licence, summary, engine, role. */
export function searchText(fields: { label: string; id: string; repo: string | null; family: string | null; version: string | null; quantization: string | null; quantization_raw: string | null; license: string | null; summary: string; engine: string | null; role: string | null }): string {
  return [fields.label, fields.id, fields.repo, fields.family, fields.version, fields.quantization, fields.quantization_raw, fields.license, fields.summary, fields.engine, fields.role].filter((value): value is string => !!value).join(" ").toLowerCase();
}
