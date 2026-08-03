# CLAUDE.md

Guidance for Claude Code when working in the dayduyen-tech repo.

## Deploy workflow

- **dayduyen.tech deploys from the `main` branch** (static site, same setup
  as duyen-io). Merge small and often; ask the user before each production
  merge and state what is in the batch.

## Project overview

- Single-page PWA for businesses: QR generator, business profiles, analytics,
  Boutique. The entire app is **`index.html`** (no build step).
- Shares the Supabase backend with duyen-io (project ref
  `qnlaaieyipeglfuepmor`). Consumer app duyen.io redirects business claims
  here via `dayduyen.tech/#claim/<qrId>`.
- **`index.html` uses CRLF line endings.** Use the Edit tool for changes;
  any script that rewrites the file must preserve CRLF (open binary or
  newline=''), or every line shows as changed in git.

## Typography standard (keep new UI consistent)

- Body baseline is **17px** (set on `body`); the whole app was bumped +2px
  in Aug 2026 for readability. When adding UI, use these sizes:
  - Micro labels/badges: **13px** minimum (never below 12px for anything a
    user must read)
  - Secondary/supporting text: **14-15px**
  - Body/default text: **16-17px**
  - Buttons and inputs: **16px+** (iOS zooms into inputs below 16px)
  - Section titles: **19-22px**; page titles: larger serif per existing style
- Prefer these px values over introducing new odd sizes; match neighboring
  components when in doubt.
