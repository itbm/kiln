# Pip — the Kiln stuntflame

Pip is the little flame who lives in the Ember theme: he perches around
the UI, throws axes on the home screen, strolls the composer ledge, does
pull-ups under the header, gets clobbered by the opening sidebar (and
sulks about it), and jetpacks over to shove it shut. Tapping him earns
you an eep.

Mid-conversation the messages are the show, so he calms right down:
spots flagged `calm` (see `anchors.ts`) confine him to the composer
ledge, where he mostly sits at the right end and takes slow strolls
along the line above the textarea — no darting over the chat. The one
exception is a streaming artefact: while its card carries
`data-art-generating` (set by `ArtifactCard`) he darts up and plays
builder on its top edge — hammer strikes, spark showers, the odd
approving inspection (`actions/build.ts`) — then returns to the ledge
the moment it completes.

He is a single `<canvas>` overlay (`PipCanvas.tsx`) driven by a
requestAnimationFrame engine (`engine.ts`). He is decorative by
contract: the canvas is `pointer-events: none`, the tick is wrapped so a
bug retires him instead of crashing the app, and `prefers-reduced-motion`
renders him as a single still frame.

## Layout

| Path              | What it is                                                     |
| ----------------- | -------------------------------------------------------------- |
| `engine.ts`       | RAF loop, shared "nervous system" (shy/anger/blink/gaze/flare) |
| `actions/`        | one file per behaviour — **add new tricks here**               |
| `accessories/`    | cosmetics drawn on top of him (hats…) — ships empty            |
| `draw/pip.ts`     | the character art itself                                       |
| `anchors.ts`      | where he may perch (driven by `data-pip-spot` attributes)      |
| `bus.ts`          | `pip.celebrate()` etc. — safe no-ops when he's not mounted     |
| `drops.ts`        | spark/smoke/sweat particles                                    |
| `palette.ts`      | his colours (scheme-aware)                                     |

## Adding an action

Two kinds, both registered in `actions/index.ts`:

- **Mode** — owns Pip exclusively while active (patrol, pull-ups, the
  drawer hit). Implement `PipAction` (`update`, optional `draw`/`pose`),
  add it to `byMode`, and give something a way to enter it (a new perch
  zone in `anchors.ts`, a bus event, …).
- **Ring act** — a short performance on the home-screen ring. Implement
  `RingAct` and append it to `ringActs`; the rest action picks one by
  weight when Pip is loitering on the ring. `axe-throw.ts` is the
  template — a Christmas variant might pop up a fir tree instead of the
  round target.

## Adding an accessory

Implement `PipAccessory` in `accessories/` and push it onto the list in
`accessories/index.ts` (a seasonal theme can do this conditionally).
Accessories draw in Pip's local unit space after his body and face — a
Santa hat is ~15 lines; there's a sketch in `accessories/index.ts`.

## Where he can perch

Anchors are plain DOM attributes, so any surface can invite him:
`data-pip-spot="ring" | "composer" | "header" | "menu" | "filters" |
"sb-search" | "sb-foot"`. Sheets, drawers and dialogs are discovered
through their existing `data-slot` attributes. `anchors.ts` re-queries
the DOM on demand, so anything that renders one of these attributes is
automatically on his map.
