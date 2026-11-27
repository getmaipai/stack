// Pure helpers for GGUF file names. No I/O, no imports from the rest of the Stack.

const BASE_QUANTS = [
  "F32",
  "F16",
  "BF16",
  "Q8_0",
  "Q6_K",
  "Q5_K_M",
  "Q5_K_S",
  "Q5_0",
  "Q5_1",
  "Q4_K_M",
  "Q4_K_S",
  "Q4_0",
  "Q4_1",
  "Q3_K_L",
  "Q3_K_M",
  "Q3_K_S",
  "Q2_K",
  "IQ4_XS",
  "IQ4_NL",
  "IQ3_M",
  "IQ3_S",
  "IQ2_M",
  "IQ2_S",
  "IQ1_S",
] as const

// Known quant tokens, including UD-prefixed forms and MXFP4, matched longest first.
const QUANT_TOKENS: string[] = [
  ...BASE_QUANTS,
  "MXFP4",
  "Q4_K_XL",
  ...BASE_QUANTS.map((token) => `UD-${token}`),
  "UD-Q4_K_XL",
].sort((a, b) => b.length - a.length || a.localeCompare(b))

export interface GgufFileName {
  base: string
  quant: string | null
  shardIndex: number | null
  shardTotal: number | null
  isProjector: boolean
}

// A token boundary is start, end, or any character that is not a letter, digit or underscore.
function isBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return true
  return !/[A-Z0-9_]/i.test(text[index]!)
}

function findQuant(upperName: string): string | null {
  for (const token of QUANT_TOKENS) {
    let from = 0
    for (;;) {
      const at = upperName.indexOf(token, from)
      if (at === -1) break
      if (isBoundary(upperName, at - 1) && isBoundary(upperName, at + token.length)) {
        return token
      }
      from = at + 1
    }
  }
  return null
}

export function parseGgufFilename(name: string): GgufFileName {
  const isProjector = name.toLowerCase().includes("mmproj")
  const withoutExt = name.replace(/\.gguf$/i, "")
  const shardMatch = withoutExt.match(/-(\d+)-of-(\d+)$/)
  let base = withoutExt
  let shardIndex: number | null = null
  let shardTotal: number | null = null
  if (shardMatch) {
    base = withoutExt.slice(0, shardMatch.index)
    shardIndex = Number.parseInt(shardMatch[1]!, 10)
    shardTotal = Number.parseInt(shardMatch[2]!, 10)
  }
  const quant = findQuant(withoutExt.toUpperCase())
  return { base, quant, shardIndex, shardTotal, isProjector }
}

export interface ShardGroup {
  base: string
  quant: string | null
  files: string[]
  complete: boolean
  projector: string | null
}

// Preference for projector files: F16 first, then BF16, then Q8_0, then anything else.
function projectorRank(quant: string | null): number {
  if (quant === "F16") return 0
  if (quant === "BF16") return 1
  if (quant === "Q8_0") return 2
  return 3
}

export function groupShards(names: string[]): ShardGroup[] {
  const projectors: Array<{ name: string; rank: number }> = []
  const groups = new Map<string, { key: string; parsed: GgufFileName; files: string[] }>()

  for (const name of names) {
    if (!/\.gguf$/i.test(name)) continue
    const parsed = parseGgufFilename(name)
    if (parsed.isProjector) {
      projectors.push({ name, rank: projectorRank(parsed.quant) })
      continue
    }
    const key = `${parsed.base}\u0000${parsed.quant ?? ""}`
    let group = groups.get(key)
    if (!group) {
      group = { key, parsed, files: [] }
      groups.set(key, group)
    }
    group.files.push(name)
  }

  let bestProjector: string | null = null
  if (projectors.length > 0) {
    const sorted = [...projectors].sort(
      (a, b) => a.rank - b.rank || a.name.localeCompare(b.name),
    )
    bestProjector = sorted[0]!.name
  }

  const result: ShardGroup[] = []
  for (const group of groups.values()) {
    const files = [...group.files].sort((a, b) => a.localeCompare(b))
    let complete = true
    if (group.parsed.shardTotal !== null && group.parsed.shardIndex !== null) {
      const present = new Set<number>()
      for (const file of group.files) {
        const parsedFile = parseGgufFilename(file)
        if (parsedFile.shardIndex !== null) present.add(parsedFile.shardIndex)
      }
      for (let shard = 1; shard <= group.parsed.shardTotal; shard += 1) {
        if (!present.has(shard)) {
          complete = false
          break
        }
      }
    }
    result.push({
      base: group.parsed.base,
      quant: group.parsed.quant,
      files,
      complete,
      projector: bestProjector,
    })
  }

  result.sort(
    (a, b) =>
      a.base.localeCompare(b.base) ||
      (a.quant ?? "").localeCompare(b.quant ?? ""),
  )
  return result
}
