// Base path for raw <img>/<a>. next/link adds it by itself; plain tags do not.
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
export const withBase = (p: string) => (p.startsWith('/') && !p.startsWith('//') ? BASE + p : p);
