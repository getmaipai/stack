// Pure variant selection for model downloads. roomBytes must come from the
// governor's measured room, never total RAM. No I/O, no imports from the rest
// of the Stack.

export interface Variant {
  id: string
  engine: string
  sizeBytes: number | null
  quant?: string
}

export interface SelectInput {
  roomBytes: number
  supportedEngines: string[]
  enginePreference: string[]
  pin?: string
}

export interface Selection {
  chosen: Variant | null
  reason: "pinned" | "pinned-unsupported-engine" | "pinned-over-budget" | "pinned-unknown-size" | "fits" | "unknown-size" | "nothing-fits" | "no-engine"
  ranked: Array<{ variant: Variant; fit: "fits" | "unknown" | "over" }>
}

type Fit = "fits" | "unknown" | "over"

export function selectVariant(variants: Variant[], input: SelectInput): Selection {
  const supported = new Set(input.supportedEngines)
  if (input.pin !== undefined) {
    const pinned = variants.find((variant) => variant.id === input.pin)
    if (pinned) {
      if (!supported.has(pinned.engine)) return { chosen: null, reason: "pinned-unsupported-engine", ranked: [{ variant: pinned, fit: "over" }] }
      if (pinned.sizeBytes !== null && pinned.sizeBytes > input.roomBytes) return { chosen: null, reason: "pinned-over-budget", ranked: [{ variant: pinned, fit: "over" }] }
      if (pinned.sizeBytes === null) return { chosen: null, reason: "pinned-unknown-size", ranked: [{ variant: pinned, fit: "unknown" }] }
      return { chosen: pinned, reason: "pinned", ranked: [{ variant: pinned, fit: "fits" }] }
    }
  }

  const remaining = variants.filter((variant) => supported.has(variant.engine))
  if (remaining.length === 0) {
    return { chosen: null, reason: "no-engine", ranked: [] }
  }

  const fits: Variant[] = []
  const unknown: Variant[] = []
  const over: Variant[] = []
  for (const variant of remaining) {
    if (variant.sizeBytes === null) unknown.push(variant)
    else if (variant.sizeBytes <= input.roomBytes) fits.push(variant)
    else over.push(variant)
  }

  const prefRank = (variant: Variant): number => {
    const at = input.enginePreference.indexOf(variant.engine)
    return at === -1 ? input.enginePreference.length : at
  }

  // Best engine preference first, then the largest size, then id ascending.
  const bySize = (a: Variant, b: Variant): number =>
    prefRank(a) - prefRank(b) ||
    (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) ||
    a.id.localeCompare(b.id)

  // Unknown sizes have no size to compare, so engine preference then id decide.
  const byId = (a: Variant, b: Variant): number =>
    prefRank(a) - prefRank(b) || a.id.localeCompare(b.id)

  const sortedFits = [...fits].sort(bySize)
  const sortedUnknown = [...unknown].sort(byId)
  const sortedOver = [...over].sort(bySize)

  const ranked: Array<{ variant: Variant; fit: Fit }> = [
    ...sortedFits.map((variant) => ({ variant, fit: "fits" as const })),
    ...sortedUnknown.map((variant) => ({ variant, fit: "unknown" as const })),
    ...sortedOver.map((variant) => ({ variant, fit: "over" as const })),
  ]

  if (sortedFits.length > 0) {
    return { chosen: sortedFits[0]!, reason: "fits", ranked }
  }
  if (sortedUnknown.length > 0) {
    return { chosen: sortedUnknown[0]!, reason: "unknown-size", ranked }
  }
  return { chosen: null, reason: "nothing-fits", ranked }
}
