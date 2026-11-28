export type ModelHealth = "healthy" | "unhealthy" | "unknown";

export type FailoverChoiceInput = {
  primary: string;
  fallbacks: string[];
  health: Record<string, ModelHealth>;
  fits?: Record<string, boolean>;
};

export type FailoverChoice = {
  serve: string | null;
  switched: boolean;
  notice: string | null;
  skipped: Array<{ model: string; why: "unhealthy" | "health-unknown" | "does-not-fit" }>;
};

export function chooseServing(input: FailoverChoiceInput): FailoverChoice {
  const skipped: FailoverChoice["skipped"] = [];
  const seen = new Set<string>();

  for (const model of [input.primary, ...input.fallbacks]) {
    if (seen.has(model)) continue;
    seen.add(model);

    if (input.health[model] === "unhealthy") {
      skipped.push({ model, why: "unhealthy" });
      continue;
    }
    if (input.health[model] !== "healthy") {
      skipped.push({ model, why: "health-unknown" });
      continue;
    }
    if (input.fits?.[model] === false) {
      skipped.push({ model, why: "does-not-fit" });
      continue;
    }

    const switched = model !== input.primary;
    return {
      serve: model,
      switched,
      notice: switched ? `${input.primary} is not answering, ${model} is answering instead.` : null,
      skipped,
    };
  }

  return {
    serve: null,
    switched: true,
    notice: "No model is answering for this role.",
    skipped,
  };
}
