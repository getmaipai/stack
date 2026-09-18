export const DOCS_SITE = "https://getmaipai.github.io/stack";

export function docsLink(page: string, anchor?: string, outbound = false): string {
  const normalized = page.replace(/^\/+|\/+$/g, "") || "getting-started";
  const fragment = anchor ? `#${anchor.replace(/^#/, "")}` : "";
  return outbound ? `${DOCS_SITE}/${normalized}/${fragment}` : `/help/${normalized}${fragment}`;
}
