# docs-kit (extractable)

Shared parts for the MaiPai public sites: tokens, nav, footer, landing blocks, badges, sponsors, star count.
Nothing here imports the site. A site passes a `SiteConfig` (see `types.ts`). Plan: move this folder to
`commons/docs-kit` as `@maipai/docs-kit`, tag it, and have Home and Stack import it. Until then it lives here.

- `kit.css`: tokens (Home cyan, Stack orange via `data-product`) and every kit class. Import once in `global.css`.
- `sponsors.json`: the one sponsor list for both sites. Empty `sponsors` shows the "Your logo here" slots.
- `stars.ts`: reads the GitHub star count at build time. Failure or below threshold gives no number.
- No outside requests, no remote fonts, no analytics.
