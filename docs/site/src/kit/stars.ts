// Star count, read once when the site is built and baked into the HTML.
// The visitor's browser never calls GitHub. A failed lookup, or a count under the
// threshold, returns null and the nav shows no number.
export const STAR_THRESHOLD = 100;

export async function getStars(user: string, repo: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${user}/${repo}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const n = Number(((await res.json()) as { stargazers_count?: number }).stargazers_count);
    if (!Number.isFinite(n) || n < STAR_THRESHOLD) return null;
    return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
  } catch {
    return null;
  }
}
