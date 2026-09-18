import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { docsLink } from "@/lib/docsLink";
import { useApiResource } from "@/lib/useApiResource";
import { Input } from "@/kit/ui/input";
import type { SectionFrameComponent } from "@/pages/DashboardShell";

export type KnowledgeRecord = { title: string; slug: string; url: string; excerpt: string };

function useKnowledgeHtml(url: string | undefined): { data?: string; error: Error | null; loading: boolean } {
  const [data, setData] = useState<string>(); const [error, setError] = useState<Error | null>(null); const [loading, setLoading] = useState(Boolean(url));
  useEffect(() => { let current = true; if (!url) { setLoading(false); return () => { current = false; }; } setLoading(true); void fetch(url).then(async (response) => { if (!response.ok) throw new Error("The guide could not be opened."); return response.text(); }).then((value) => { if (current) { setData(value); setError(null); } }).catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason : new Error("The guide could not be opened.")); }).finally(() => { if (current) setLoading(false); }); return () => { current = false; }; }, [url]);
  return { data, error, loading };
}

function sanitizeHtml(source: string): string {
  if (typeof DOMParser === "undefined") return "";
  const document = new DOMParser().parseFromString(source, "text/html");
  const allowed = new Set(["A", "BLOCKQUOTE", "BR", "CODE", "EM", "H1", "H2", "H3", "H4", "HR", "IMG", "LI", "OL", "P", "PRE", "STRONG", "UL"]);
  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    if (!allowed.has(element.tagName)) { element.replaceWith(...Array.from(element.childNodes)); continue; }
    for (const attribute of Array.from(element.attributes)) {
      const value = attribute.value.trim();
      const safeLink = attribute.name === "href" && /^(https?:\/\/|\/|#)/i.test(value);
      const safeImage = attribute.name === "src" && /^(https?:\/\/|\/)/i.test(value);
      if (!(attribute.name === "id" || attribute.name === "alt" || safeLink || safeImage)) element.removeAttribute(attribute.name);
    }
  }
  return document.body.innerHTML;
}

export function HelpPage({ Frame }: { Frame: SectionFrameComponent }) {
  const { page } = useParams<{ page?: string }>();
  const index = useApiResource<{ records: KnowledgeRecord[] }>("/knowledge/index.json");
  const updates = useApiResource<{ app?: { checksEnabled?: boolean } }>("/stack/v1/updates");
  const [query, setQuery] = useState("");
  const records = useMemo(() => index.data?.records ?? [], [index.data]);
  const selected = records.find((record) => record.slug === page) ?? records[0];
  const html = useKnowledgeHtml(selected?.url);
  const filtered = useMemo(() => records.filter((record) => `${record.title} ${record.excerpt}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [query, records]);
  const outbound = updates.data?.app?.checksEnabled === true;
  return <Frame title="Help" description="Guides that came with this Stack, ready when the internet is not."><div className="grid gap-6 lg:grid-cols-[15rem_1fr]"><aside className="space-y-4"><label className="block text-sm font-medium" htmlFor="help-search">Search Help<Input id="help-search" className="mt-2" placeholder="Search Help" value={query} onChange={(event) => setQuery(event.target.value)} /></label><nav aria-label="Help pages" className="space-y-1">{filtered.map((record) => <Link className={`block rounded-md px-3 py-2 text-sm ${record.slug === selected?.slug ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted"}`} key={record.slug} to={`/help/${record.slug}`}>{record.title}</Link>)}</nav></aside><article className="min-w-0"><div className="mb-5 flex justify-end">{selected && outbound && <a className="text-sm underline" href={docsLink(selected.slug, undefined, true)} target="_blank" rel="noreferrer">Open on the docs site</a>}</div>{html.loading && <p className="text-sm text-muted-foreground">Loading this guide...</p>}{html.error && <p className="text-sm text-destructive">This guide could not be opened.</p>}{html.data && <div className="prose max-w-none text-base leading-7 dark:prose-invert" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html.data) }} />}</article></div></Frame>;
}
