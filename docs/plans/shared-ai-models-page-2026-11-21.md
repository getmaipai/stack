# One AI and models page, owned by the Stack (design, 2026-11-21)

Owner decision (Jesse, 2026-11-21): the Stack holds everything about models:
the catalog, presets, customizations, ordering (priority), assignment per tier
and enablement. Home is a view into the Stack and one way to change it. A
person can use the Stack fully without Home. So the "AI and models" page in
Home and the Models, Features and priority screens in the Stack admin page are
one page, built once, saving every choice to the Stack.

## The rule

One component, one place. The page is a single component in
`@maipai/ui` (commons, imports no product). The Stack admin page and Home both
render it. Neither holds a second copy of the layout, the wording, the
tokens or the choice logic.

## What it is

`StackModelsPage` in `commons/ui/src/stack/` (new folder), plus `useStackChoices`.

- It takes one prop that matters: `client: StackClient`, an interface of typed
  calls (read the overview, set a role on or off, set priority, choose a model
  for a role and tier, apply a profile, install, remove, read job progress).
  The component never calls `fetch`.
- Its types come from `@maipai/spec` (spec first): the shapes of the Stack's
  `/stack/v1/*` answers (roles, models, profiles, recommend, priority, jobs)
  are written once as Zod schemas in spec and generated from the Stack's
  OpenAPI document. The Stack, Home and the component all import them.
- It renders from kit primitives only (cards, rows, sheets, the settings
  renderer), tokens only. The Stack's own plain-words fit decision
  (`profiles/recommend`) is shown as the Stack wrote it; no screen rewrites it.
- Slots for what only one host has: `extraSections` (Home adds disk and
  backup links, the admin page adds Tools) and `lockedItems` (Home marks items
  a child profile or an unaccepted adult unlock may not change). The page never
  knows who is asking; the host decides what to lock.

## Two thin adapters, one truth

| Host | `client` talks to | What the host adds |
|---|---|---|
| Stack admin page | `/stack/v1/*` on the same origin, session cookie and CSRF | nothing |
| Home | Home's own `/api/ai/*`, which forwards each call to the Stack unchanged | Home's sign-in, admin-only rule, child and adult gates, audit line |

Home's route stores nothing. It checks who is asking, then forwards. Home
deletes its own copies of the choice logic (`aiChoicesApi`, `useAiChoices`,
`AiGlance`, `AiSlotDialog`, `ModelsSection`, the tier slots and the
backend side of `/api/ai/choices`) once the shared page replaces them. The
Stack's tier table routes (STACK-OWNS-MODEL-CHOICES, the sibling plan in Home
`docs/plans/stack-owns-model-choices-2026-11-21.md`) are the data this page
reads; this plan is the UI half of that one.

## Build order

1. Spec: the answer shapes for roles, models, tiers, priority and profiles, and a
   generated check that the Stack's OpenAPI still matches them.
2. Stack: any missing route the page needs, listed by the component's first
   build (additive only; no route is invented in the UI).
3. Commons: `StackModelsPage`, `useStackChoices` and a fake `StackClient` for
   tests and screenshots; tag `ui` and `spec`.
4. Stack admin page: replace `Models.tsx`, `Features.tsx` and the priority
   pieces with the component (first consumer, no Home needed to prove it).
5. Home: replace the AI and models page and the settings pickers with the
   component over the `/api/ai/*` forwarder; delete the old code and its tests;
   pin the new `ui` and `spec` tags and the Stack commit.
6. Screenshots of the one page in both hosts; they must match except for slots.

## Decisions taken (change on request)

- Model choice stays pinned to the catalog; no general model search in v1.
- The forwarder in Home is a thin proxy of the same routes, not a new API.
- A choice made in either app shows in the other at once, because both read the
  Stack's SSE feed through the same hook.
- Home's household wording (dad-test copy) comes from i18n in the component, so
  both apps read the same sentences.

## Not decided here

How the Stack lets Home ask "who may change this" without learning who is asking
(the host gates, the Stack trusts its one caller). Kept as is: Home gates, the
Stack stays unaware of people.
