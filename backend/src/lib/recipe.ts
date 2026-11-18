// MODELPACK-JOBS-01: fills a pack recipe. A recipe file has up to three parts split by `---words---` and `---measured---` lines: the base
// template, the addendum added only when exact words are present, and a plain "measured on" note that is never sent to a model. Blanks are
// `{description}`, `{words}`, `{references}`. The Stack never writes a person's words anywhere else (rule W3: only exact words are spelled).
export interface RecipeInputs { description: string; words?: string | undefined; references?: string | undefined }

export function parseRecipe(text: string): { base: string; wordsAddendum: string | null; measured: string | null } {
  const [head = "", ...rest] = text.split(/^---(words|measured)---$/m);
  const parts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) parts[rest[i]!] = (rest[i + 1] ?? "").trim();
  return { base: head.trim(), wordsAddendum: parts.words ?? null, measured: parts.measured ?? null };
}

const fill = (template: string, values: RecipeInputs): string => template.replaceAll("{description}", values.description).replaceAll("{words}", values.words ?? "").replaceAll("{references}", values.references ?? "");

export function fillRecipe(text: string, inputs: RecipeInputs): string {
  const { base, wordsAddendum } = parseRecipe(text);
  const prompt = fill(base, inputs);
  return inputs.words && wordsAddendum ? `${prompt}\n\n${fill(wordsAddendum, inputs)}` : prompt;
}
