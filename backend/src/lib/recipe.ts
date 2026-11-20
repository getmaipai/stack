// MODELPACK-JOBS-01: fills a pack recipe. A recipe file has up to four parts split by `---words---`, `---identity---` and `---measured---` lines (the identity part is the base used when the request carries an identity input): the base
// template, the addendum added only when exact words are present, and a plain "measured on" note that is never sent to a model. Blanks are
// `{description}`, `{words}`, `{references}`, and for music `{bpm}`, `{key}`, `{language}`. A template line that holds one of the music blanks is
// dropped when the request left that blank empty, so a song without a tempo never says "beats per minute". The Stack never writes a person's words
// anywhere else (rule W3: only exact words are spelled).
export interface RecipeInputs { description: string; words?: string | undefined; references?: string | undefined; bpm?: string | undefined; key?: string | undefined; language?: string | undefined; /** The request carries an identity input: use the recipe's `---identity---` part as the base when it has one. */ identity?: boolean | undefined }
const OPTIONAL_BLANKS = ["bpm", "key", "language"] as const;

export function parseRecipe(text: string): { base: string; wordsAddendum: string | null; measured: string | null; identity?: string } {
  const [head = "", ...rest] = text.split(/^---(words|measured|identity)---$/m);
  const parts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) parts[rest[i]!] = (rest[i + 1] ?? "").trim();
  return { base: head.trim(), wordsAddendum: parts.words ?? null, measured: parts.measured ?? null, ...(parts.identity !== undefined ? { identity: parts.identity } : {}) };
}

const fillLine = (line: string, values: RecipeInputs): string => {
  const music = OPTIONAL_BLANKS.reduce((out, name) => out.replaceAll(`{${name}}`, values[name] ?? ""), line);
  return music.replaceAll("{description}", values.description).replaceAll("{words}", values.words ?? "").replaceAll("{references}", values.references ?? "");
};
const emptyOptional = (line: string, values: RecipeInputs): boolean => OPTIONAL_BLANKS.some((name) => line.includes(`{${name}}`) && !values[name]);
const fillLines = (template: string, values: RecipeInputs): string[] => template.split("\n").filter((line) => !emptyOptional(line, values)).map((line) => fillLine(line, values));
const fill = (template: string, values: RecipeInputs): string => fillLines(template, values).join("\n");

/** The filled base template as one entry per template line, so a caller can join them its own way (a music caption joins with commas). */
export function fillRecipeLines(text: string, inputs: RecipeInputs): string[] {
  return fillLines(parseRecipe(text).base, inputs).filter((line) => line.trim() !== "");
}

export function fillRecipe(text: string, inputs: RecipeInputs): string {
  const { base, wordsAddendum, identity } = parseRecipe(text);
  const prompt = fill(inputs.identity && identity ? identity : base, inputs);
  return inputs.words && wordsAddendum ? `${prompt}\n\n${fill(wordsAddendum, inputs)}` : prompt;
}
