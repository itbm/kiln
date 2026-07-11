# Kiln — agent & contributor guide

Kiln is a local-first mobile AI chat PWA (React 19 + Vite 8 + Tailwind 4 +
shadcn/ui + Dexie), served by unprivileged nginx in Docker. Read the README
for the feature overview; this file is about working on the code.

## Releasing / finishing a change

- **Bump `VERSION`** (root of the repo) on every change that will be
  deployed. It is the single source of truth: Vite bakes it in at build
  time (`__APP_VERSION__`, also during `docker build`) and it is shown at
  the bottom of Settings — it's how the user checks a deploy actually
  landed. Patch for fixes, minor for features. CI also tags the published
  image with it (`ghcr.io/itbm/kiln:<VERSION>` + `:latest` on pushes to
  `main`; PRs only test the build) — see `.github/workflows/docker.yml`.
- Run the checks below and make sure they pass before pushing.

## Commands

```bash
npm run dev                    # dev server (has /api/ollama proxy)
npm run build                  # type-check (tsc -b) + production build — must pass
npm run preview                # serve dist/ on :4173 (needed by the two scripts below)
node scripts/e2e-mock.mjs      # end-to-end suite against a mocked provider — must pass
node scripts/verify-fresh.mjs  # first-run + key-gated live model fetch checks
npm run shots                  # regenerate the screenshot set into shots/
npm run icons                  # regenerate PWA icons from public/icons/icon.svg
```

Playwright uses the preinstalled Chromium at `/opt/pw-browsers/chromium`
(override with `CHROMIUM_PATH`).

## Conventions

- **British English in UI copy** ("artefact", "favourites", "colour",
  "personalisation"). The artifact wire protocol is the exception: the
  `<artifact …>` tag and its `type` values stay US-spelled — it's the
  convention models know, and changing it would break existing saved chats.
- **Never rename the storage identifiers**: the Dexie database name
  (`amber`) and localStorage keys (`amber-settings`, `amber-models-cache`)
  predate the Kiln rebrand and are kept so existing installs keep their
  data. Export files accept both `app: "kiln"` and legacy `"amber"`.
- Model metadata (context length, effort options, capabilities) must come
  from the provider APIs, not hardcoded lists — see
  `src/lib/providers/*.ts`. When `ModelInfo` gains fields, bump
  `CACHE_VERSION` in `src/stores/models.ts` so stale caches refetch.
- Providers are only contacted when the user has configured their key.
- Inputs need `text-[16px]` on mobile (or the shared Input/Textarea
  components) to stop iOS zoom-on-focus. Use `confirmDialog`/`promptDialog`
  from `src/stores/dialogs.tsx`, never `window.confirm/prompt`.
- Edge-flush bottom surfaces use `pb-safe-plus`.

## Parked features

- **Ollama usage ring** (approved design: `docs/mockups/usage-ring.png`) —
  blocked upstream: Ollama exposes no subscription-usage API yet
  (ollama/ollama#15132, #15663, #16448; `/api/me` returns account info
  only, no rate-limit headers on responses — verified July 2026). When the
  endpoint ships, implement the mockup: ring beside send (most-constrained
  window), tap/hover detail bars, Settings card. Until then a 429 from
  Ollama surfaces as a friendly limit-reached message (providers/ollama.ts).

## Architecture pointers

- `src/lib/engine.ts` — the assistant turn loop: streaming, tools,
  versions, auto-compaction, titles. Persists partial output continuously.
- `src/lib/providers/` — OpenRouter (SSE) and Ollama (NDJSON) clients with
  a unified StreamEvent interface. Ollama cloud has no CORS; traffic goes
  through the same-origin `/api/ollama` relay (nginx in prod, Vite proxy in
  dev/preview).
- `src/stores/` — zustand: settings (persisted), models cache, live
  streams, temp chats, dialogs.
- `src/lib/compact.ts`, `commands.ts`, `versions.ts`, `artifacts.ts`,
  `questions.ts` — context compaction, slash commands, response versions,
  artifact parsing, interactive `<questions>` blocks.
- `deploy/nginx.conf` + `Dockerfile` + `compose.yaml` — hardened
  runtime: read-only fs, tmpfs /tmp only, no access logs, no proxy
  buffering to disk, cookies stripped on the relay.
