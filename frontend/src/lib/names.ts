export function displayName(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const withoutExtension = value.replace(/\.(gguf|safetensors|bin)$/i, "").replace(/-q\d+(?:-\d+)?$/i, "");
  const build = withoutExtension.match(/^(b\d+)(?:-[a-f0-9]+)?$/i);
  if (build) return build[1]!;
  return withoutExtension
    .replace(/[-_]+/g, " ")
    .replace(/\bqwen(\d)/gi, "Qwen$1")
    .replace(/\b(\d+(?:\.\d+)?)b\b/gi, "$1B")
    .replace(/\b(llama|mistral|moonshine|piper|flux)\b/gi, (word) => word[0]!.toUpperCase() + word.slice(1))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
