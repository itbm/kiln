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
npm run dev                    # dev server (has /api/ollama, /api/cloud + /api/forge proxies)
npm run cloud                  # cloud turn runner on :8090 (run beside dev/preview to see the pill)
npm run forge                  # coding runner on :8091 (needs KILN_WORKSPACE_ROOT + an sbx daemon)
npm run build                  # type-check (tsc -b) + production build — must pass
npm run preview                # serve dist/ on :4173 (needed by the three scripts below)
node scripts/e2e-mock.mjs      # end-to-end suite against a mocked provider — must pass
node scripts/e2e-cloud.mjs     # cloud runtime end-to-end (spawns its own runner + mock) — must pass
node scripts/e2e-github.mjs    # on-device GitHub slice against a mocked api.github.com — must pass
node scripts/e2e-forge.mjs     # coding runtime against a mock sbx daemon + mock agent — must pass
node scripts/e2e-sbx-contract.mjs  # the sbx driver's requests vs the published API — must pass
node scripts/verify-fresh.mjs  # first-run + key-gated live model fetch checks
npm run shots                  # regenerate the screenshot set into shots/
npm run icons                  # regenerate PWA icons from public/icons/icon.svg
npm run splash                 # regenerate iOS launch images + their index.html tags
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
- **Dexie schema changes are additive**: add a `this.version(n).stores({…})`
  declaring only the new/changed tables and leave the earlier declarations
  alone — every install carries the user's entire history. `verify-fresh.mjs`
  phase 3 seeds a database at the previous schema (Dexie's IDB version is its
  own version × 10) and proves the upgrade keeps chats and messages; extend
  it when you bump the version.
- Model metadata (context length, effort options, capabilities) must come
  from the provider APIs, not hardcoded lists — see
  `src/lib/providers/*.ts`. When `ModelInfo` gains fields, bump
  `CACHE_VERSION` in `src/stores/models.ts` so stale caches refetch.
- **`server/forge/` and `server/agent/` are the coding runtime.** The forge is
  dependency-free like `cloud.mjs` — it reaches the sbx daemon with
  `http.request({ socketPath })`, so there is nothing to install. `server/agent/`
  is the exception that proves the rule: it needs
  `@anthropic-ai/claude-agent-sdk`, but it runs *inside the microVM* and ships
  as a kit, so it never enters the Kiln image. Everything uncertain about sbx
  lives in `server/forge/sandbox.mjs` and nowhere else — and because sbx
  cannot run in CI (it binds to the platform hypervisor and has no software
  emulation, so QEMU is not a fallback), `scripts/e2e-sbx-contract.mjs` checks
  that driver's requests against the published API instead. Update the spec
  transcription at the top of that file when sbx's API moves.
- **`server/cloud.mjs` mirrors client code by design** (it's a
  dependency-free plain-Node file, so it can't import from `src/`): the
  provider stream parsing mirrors `src/lib/providers/*.ts`, the tool
  execution mirrors `src/lib/tools.ts`, the round loop mirrors
  `runLocalRounds` in `src/lib/engine.ts`, and its journal entries are the
  `TurnEvent` type in `src/lib/types.ts`. Change any of those → mirror the
  change in the runner, and keep `scripts/e2e-cloud.mjs` passing.
  Two asymmetries are deliberate, not drift to be tidied away: the runner's
  `web_fetch` refuses private/reserved addresses (the client's reaches only
  the user's own network, and a browser can't inspect redirect hops anyway),
  and its `stripHtml` is a regex because there's no DOM to parse with.
- Providers are only contacted when the user has configured their key.
- Inputs need `text-[16px]` on mobile (or the shared Input/Textarea
  components) to stop iOS zoom-on-focus. Use `confirmDialog`/`promptDialog`
  from `src/stores/dialogs.tsx`, never `window.confirm/prompt`.
- Edge-flush bottom surfaces use `pb-safe-plus`.

## Architecture pointers — coding chats

- `server/forge/` — the host-side coding runner: clones into
  `$KILN_WORKSPACE_ROOT/<chatId>/repo` (an **encrypted mount**, see
  `deploy/encrypted-workspace.md`), brings up an sbx microVM on it, and relays
  `kiln-agent`'s stream into the same seq-numbered `TurnEvent` journal the
  cloud runner uses. `git.mjs` owns clone/commit/push *and* the guard that
  refuses to push Kiln's own state — deliberately outside the sandbox, so it
  isn't reachable by the process it guards.
- `server/agent/` — the resident Claude Code session inside the VM. One
  `query()` per chat, fed from an async iterable, so many messages share one
  session. It is what makes `canUseTool` possible, which is what turns into
  question chips on the phone.
- `src/lib/forge.ts` + `src/stores/forge.ts` + `runForgeRounds` in
  `engine.ts` — a near-copy of the cloud trio. No forge → no Code chat entry
  point, so a server without one shows no dead UI.
- Kiln's own state is a **sibling** of the git tree (`$WS/.kiln`, with `HOME`
  and `CLAUDE_CONFIG_DIR` inside it), never a child — that is what keeps
  `git add -A` from reaching it. Don't "tidy" it into the repo directory.

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
  One consumer (`consumeTurn`) applies a flat `TurnEvent` stream from either
  driver: `runLocalRounds` (on-device provider calls + tools) or
  `runCloudRounds` (attach to a server-side job's journal, re-attaching
  through connection loss; a `reset` event precedes each replay).
  `resumeCloudTurns` catches up on jobs after a relaunch — wired to boot,
  foregrounding and `online` in `App.tsx`.
- `src/lib/cloud.ts` + `src/stores/cloud.ts` + `server/cloud.mjs` — the
  cloud runtime: chats flipped to **Cloud** (composer pill) POST the whole
  turn to `/api/cloud/jobs`; the runner (same container, Node on
  127.0.0.1:8090, memory-only) executes provider rounds + tools and
  journals seq-numbered TurnEvents; clients replay/tail the journal over
  SSE, then DELETE the job. Keys travel inside the job payload and are
  scrubbed server-side when the turn ends. The store probes
  `/api/cloud/health` once at boot; no runner → no pill. Temporary chats
  never go cloud.
- `src/lib/providers/` — OpenRouter (SSE) and Ollama (NDJSON) clients with
  a unified StreamEvent interface. Ollama cloud has no CORS; traffic goes
  through the same-origin `/api/ollama` relay (nginx in prod, Vite proxy in
  dev/preview).
- `src/stores/` — zustand: settings (persisted), models cache, live
  streams, temp chats, dialogs.
- `src/lib/themes/` — app-theme registry (Ember, Classic; one file per
  theme). Components consult `theme.features.*` flags, never theme ids.
  Token blocks + theme-scoped component skins live in
  `src/themes/<id>.css` hung off `data-ui` hooks; fonts are self-hosted
  Latin subsets (`src/themes/fonts.css`). The pre-paint script in
  `index.html` mirrors the `theme-<id>` html class.
- `src/pip/` — Pip the stuntflame (canvas mascot; every theme sets
  `features.pip`, the Settings toggle mutes him). One file per behaviour
  under `actions/`, cosmetics under `accessories/`, perch anchors via
  `data-pip-spot` attributes; see `src/pip/README.md` before teaching
  him new tricks.
- `src/lib/compact.ts`, `commands.ts`, `versions.ts`, `artifacts.ts`,
  `questions.ts` — context compaction, slash commands, response versions,
  artifact parsing, interactive `<questions>` blocks.
- `src/lib/find.ts` — find in chat. Hits are painted with the CSS Custom
  Highlight API (ranges only, never DOM mutation, so the markdown renderer
  is untouched); chrome that shouldn't match carries `data-find-skip`, and
  messages carry `data-msg-id` so a sidebar search result can scroll to the
  message it matched (`/chat/:id?m=…&q=…`).
- `src/lib/branch.ts` — fork a chat at one reply (new message ids, original
  `createdAt` kept; a temporary chat branches into another temporary chat).
  The non-destructive counterpart to `regenerateReply`, which replaces
  everything after the reply it re-runs.
- `src/lib/time.ts` — `clockTime` / `dayLabel` / `sameDay` / `fullDateTime`.
  All date and time copy goes through here (en-GB), including the transcript
  header and the chat's day dividers.
- `src/lib/transcript.ts` — a chat as human-readable Markdown (copy, share
  sheet, `/export md`). Built synchronously from the messages already on
  screen: Safari only permits `navigator.share`/clipboard writes while the
  tap that asked for them is still the current task, so never `await`
  anything before calling them.
- `src/lib/drafts.ts` — unsent composer text, one draft per chat (or a
  `NEW_*_DRAFT` key before the chat exists). Mirrored into the Dexie
  `drafts` store on an idle debounce and flushed on `pagehide` /
  backgrounding, because an iOS PWA is usually killed rather than unloaded.
  Temporary chats are `ephemeral`: cache only, never written to disk.
- `src/lib/usage.ts` — provider-reported token/cost accounting: per-reply
  `Message.usage` (captured by the engine from stream `done` events, one
  per tool round), formatting, and per-chat totals. Usage is only ever
  provider-reported, never estimated — the chars/4 heuristic in
  `compact.ts` is for context budgeting only.
- `deploy/nginx.conf` + `Dockerfile` + `compose.yaml` — hardened
  runtime: read-only fs, tmpfs /tmp only, no access logs, no proxy
  buffering to disk, cookies stripped on the relay. The image also carries
  the cloud runner: nginx proxies `/api/cloud/` → 127.0.0.1:8090
  (buffering off — SSE), and the CMD keeps `node /opt/kiln/cloud.mjs`
  running beside nginx with a restart loop.
