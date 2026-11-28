# MaiPai Stack site

The public static site for MaiPai Stack: a landing page, a Features index, seven feature pages and a "Works with" page.
Design record: `getmaipai/home` `docs/design/readme-and-landing-pages-2026-11-28.md`.

- **Build:** `bun install`, then `bun run build`. The static export lands in `out/`. `bun run serve` previews it on port 3021.
- **Feature pages:** all seven come from `features.json` (the one source). Edit a line there, not in the page code.
- **Screenshots:** copied from `docs/images/admin/` into `public/screens/` at build time (git-ignored), so there is one copy.
- **Star count:** read once at build time and baked in, shown only above 100. The visitor's browser never calls GitHub. No remote fonts, no analytics.
- **Publishing is manual** (no workflow). Where the built site is hosted is not decided; set `DOCS_BASE_PATH` for a sub-path.
- **Claims:** each statement was checked against the Stack code or docs on 2026-11-28. Cut one that stops being true.
  No queue fairness between people, no retry of failed jobs and no job offload to a second computer exist, so the site does not say them.

## The kit is a copy

`src/kit/` is copied from the MaiPai Home site (`docs/site-fumadocs/src/kit` in `getmaipai/home`), which names it as the future
`@maipai/docs-kit` in `getmaipai/commons`. Until that package is tagged, these files exist twice: `base.ts`, `client.tsx`, `icons.tsx`,
`stars.ts`, `types.ts`, `kit.css`, `blocks.tsx` and `sponsors.json` (the sponsor list should be one shared file).
Local changes: an optional `extraLinks` nav entry in `types.ts` and `blocks.tsx`, and the docs and privacy links are plain links to the
GitHub docs. Merge changes back both ways until the package exists.
