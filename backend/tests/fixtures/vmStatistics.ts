// `host_statistics64(HOST_VM_INFO64)` page counts for the memory reader
// and governor tests, laid out at the kernel's own word offsets in
// `vm_statistics64_data_t` (38 32-bit words; 64-bit counters take two).

export const PAGE_BYTES = 16_384;

export interface VmPages {
  free: number;
  active: number;
  inactive: number;
  wired: number;
  purgeable: number;
  speculative: number;
  compressor: number;
  external: number;
  internal: number;
  /** The high word of the 64-bit `faults` counter (word 13), which the
   * reader before 2026-10-06 added to free memory by mistake. */
  faultsHighWord?: number;
}

export function vmStatistics(pages: VmPages): Uint32Array {
  const words = new Uint32Array(38);
  words[0] = pages.free;
  words[1] = pages.active;
  words[2] = pages.inactive;
  words[3] = pages.wired;
  words[13] = pages.faultsHighWord ?? 1;
  words[22] = pages.purgeable;
  words[23] = pages.speculative;
  words[32] = pages.compressor;
  words[34] = pages.external;
  words[35] = pages.internal;
  return words;
}

/** The p16 laptop (24 GiB, Apple M4 Pro) on 2026-10-06 when the honest
 * 8B chat (8,436,858,360 B) could not start: the governor reported
 * "8.2 GB free" (free plus inactive pages) while `memory_pressure` said
 * 69 percent free and pressure was normal, with about 8.4 GB inactive,
 * about 4 GB free and speculative, and about 16 GB of file-backed cache.
 * The split of those figures into page counts is reconstructed from the
 * coordinator's reading; the sums are the event's. */
export const EVENT_2026_10_06: VmPages = {
  free: 24_414, // 0.40 GB
  active: 328_369, // 5.38 GB
  inactive: 512_695, // 8.40 GB
  wired: 450_000,
  purgeable: 3_052, // 0.05 GB
  speculative: 219_727, // 3.60 GB
  compressor: 30_000,
  external: 976_562, // 16.0 GB: the speculative pages, the inactive file cache and the active file cache
  internal: 84_229, // active + inactive + speculative - external
};

/** Read live on the same laptop at 14:4x UTC on 2026-10-06, with the 8B
 * chat engine and the embed engine loaded and Home's gate running
 * (`vm_stat` agreed page for page; `memory_pressure` said 35 percent). */
export const LIVE_CHAT_LOADED_2026_10_06: VmPages = {
  free: 44_585,
  active: 253_713,
  inactive: 250_370,
  wired: 708_180,
  purgeable: 8_419,
  speculative: 2_143,
  compressor: 260_298,
  external: 172_377,
  internal: 333_849,
};
