# Pip — the Kiln stuntflame

Pip is the little flame who lives in every theme (born in Ember, kept on
in Classic — the Settings toggle is the only thing that retires him): he
perches around the UI, puts on turns on the home screen (axe throwing,
the high wire, juggling embers), strolls the composer ledge, does
pull-ups under the header, gets clobbered by the opening sidebar (and
sulks about it), and jetpacks over to shove it shut. Tapping him earns
you an eep.

He also feels the conversation. While he's on stage the system prompt
asks the model to open every reply with a hidden `<emotion>…</emotion>`
tag (see `src/lib/emotions.ts`); the stream watcher in `src/lib/engine.ts`
hands it to `pip.emote()` the moment it completes, and `splitContent`
strips it so users never see it. Some models drift into a bare
`<thoughtful>`-style tag instead — both parsers tolerate that dialect at
the start of a reply. Quick feelings (happy, surprised, angry)
are pulses on his existing envelopes; lingering ones set a mood that
colours everything for a while and then fades — mildly sad news banks his
flame down, droops his brows and mouth, swaps his idle hops for sighs and
wells his eyes up with the odd tear rolling out, so sadness is never
ambiguous; truly heartbreaking news (`crying`) turns that into proper
streams with a sniffly shudder; `excited` keeps him bouncing, `thoughtful` sends his
gaze drifting upward between slow blinks, `worried` is a low-grade frown.
A glum mood also mutes the end-of-reply celebration — he darts home
without the wave and confetti.

Mid-conversation the messages are the show, so he calms right down:
spots flagged `calm` (see `anchors.ts`) confine him to the composer
ledge, where he mostly sits at the right end and takes slow strolls
along the line above the textarea — no darting over the chat. The one
exception is a streaming artefact: while its card carries
`data-art-generating` (set by `ArtifactCard`) he darts up, puts on his
yellow **hard hat** (site rules) and plays builder on its top edge
(`actions/build.ts`) — and the longer the job runs, the bigger the show:

- **Hammer** first: strikes, spark showers, the odd approving
  inspection.
- Every ~8–13 s he swaps tools — hammer → **hand saw** (leaning strokes,
  wood chips) → **drill** (held two-handed on its T-bar, pumping into
  the edge — it judders him *and* the card) → round again.
- Past **30 s** he decides the job needs relocating: grabs the top
  edge, fires the jetpack and airlifts the actual card — a real CSS
  transform on the DOM node. Given headroom he hauls it right up to
  just under the header, cuts the engines, pops a cream-and-orange
  **parachute** and pendulum-drifts the whole rig back down before
  plonking it home with a bounce (in a cramped viewport he falls back
  to the old low hover-and-sway). Then back to work — repeat roughly
  every half minute. The transform is always undone:
  `BuildAction.exit()` releases it, and `engine.leaveMode()` invokes
  that from every path that can take the mode over (darting off, drawer
  hit, jetpack call-out, teardown, error retirement). Each card's
  clock/tool/heave state lives in a WeakMap keyed on the card element,
  so popping off for an overlay doesn't reset it.

He returns to the ledge the moment the card completes.

On the **Images** page the same trick runs in a smock: while a picture
generates, the "Painting…" tile carries `data-art-painting` and he darts
up onto its top edge in a **beret**, palette in his off hand
(`actions/paint.ts`) — dipping for a fresh colour, dabbing, laying a long
stroke, and now and then leaning back to size up the composition down the
handle of his brush. Past **22 s** the job has earned a **signature**: he
scoots to the corner and flourishes one onto the canvas, which then dries
away on its own. He drops everything and goes home the moment the picture
lands.

A **compaction** puts him to work too: `compactChat` calls
`pip.tidy(true/false)` around the summarising request, so while the older
messages are being swept into a summary he fetches a **broom** and works
the composer ledge in clouds of dust (`actions/sweep.ts`), finishing with
two taps of the handle when the summary arrives. He gives up after 30 s
if the call never comes.

And when a turn **falls over** he takes it personally (`actions/swoon.ts`,
wired from `lib/engine.ts`): a rate limit (429) spins him **dizzy** —
staggering on the spot with stars orbiting his head — while any other
stream error is a proper **faint**: he reels, keels over backwards and
lies there with his flame guttering down to smoke before coming to.

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
| `bus.ts`          | `pip.celebrate()`/`tidy()`/`mishap()` — no-ops when unmounted  |
| `drops.ts`        | spark/smoke/sweat particles                                    |
| `palette.ts`      | his colours (scheme-aware)                                     |

## Adding an action

Two kinds, both registered in `actions/index.ts`:

- **Mode** — owns Pip exclusively while active (patrol, pull-ups, the
  drawer hit). Implement `PipAction` (`update`, optional
  `draw`/`pose`/`drawFront`/`exit`), add it to `byMode`, and give
  something a way to enter it (a new perch zone in `anchors.ts`, a bus
  event, …). Drawing is layered: `draw` renders **behind** him (scenery —
  the pull-up bar, a target board, clouds), `drawFront` renders **over**
  him and is for things he holds — set `pose.grip`/`gripB` so his arms
  reach the handle, then draw the tool + closed hand in his transformed
  unit space (the builder's toolkit in `build.ts` is the template).
- **Ring act** — a short performance on the home-screen ring. Implement
  `RingAct` and append it to `ringActs`; the rest action picks one by
  weight when Pip is loitering on the ring. `axe-throw.ts` is the
  template — a Christmas variant might pop up a fir tree instead of the
  round target. Acts drive him by writing `engine.px/py/tiltExtra/windup`
  each frame, and they get the same optional `pose`/`drawFront` hooks a
  mode does (RestAction forwards them to whichever act is running): the
  tightrope uses them to put his arms out on a balance pole
  (`tightrope.ts`), and the juggler to hold the cascade of embers over
  his body (`juggle.ts`).

## Adding an accessory

Implement `PipAccessory` in `accessories/` and push it onto the list in
`accessories/index.ts` (a seasonal theme can do this conditionally).
Accessories draw in Pip's local unit space after his body and face — a
Santa hat is ~15 lines; there's a sketch in `accessories/index.ts`.

## What the app tells him

Everything the app knows goes through `bus.ts`, and every call is a safe
no-op when he isn't mounted (theme without Pip, Settings toggle off,
reduced motion). Nothing outside `src/pip/` imports the engine.

| Call | Sent from | He… |
| ---- | --------- | --- |
| `pip.flare()` / `pip.celebrate()` | `PipCanvas` (stream store) | flares up on send, darts home on landing |
| `pip.emote(mood)` | `lib/engine.ts` | takes the reply's mood (`lib/emotions.ts`) |
| `pip.tidy(on)` | `lib/compact.ts` | sweeps while the chat is compacted |
| `pip.mishap(kind)` | `lib/engine.ts` | goes dizzy (`"rate"`) or faints (`"error"`) |
| `pip.notify()` | anything that reshuffles the layout | re-perches if his spot has gone |
| `pip.drawerOpening()` / `Closing()` | `AppShell` | braces for the sidebar, then jets after it |

In dev, `__pip` on `window` fires all of them by hand, and
`__pip.engine()` hands you the live engine (`engine().actions…`) for
poking an action directly.

## Where he can perch

Anchors are plain DOM attributes, so any surface can invite him:
`data-pip-spot="ring" | "composer" | "header" | "menu" | "filters" |
"sb-search" | "sb-foot"`. Sheets, drawers and dialogs are discovered
through their existing `data-slot` attributes. `anchors.ts` re-queries
the DOM on demand, so anything that renders one of these attributes is
automatically on his map.
