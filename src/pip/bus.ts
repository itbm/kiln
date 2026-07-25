/**
 * Loose coupling between the app and Pip: components call pip.* freely;
 * every call is a safe no-op unless a PipCanvas is mounted (Pip off in
 * Settings, Classic theme, reduced motion, etc.).
 */
export interface PipHandle {
  notify(): void
  celebrate(): void
  flareUp(): void
  emote(emotion: string): void
  tidy(on: boolean): void
  mishap(kind: string): void
  drawerOpening(): void
  drawerClosing(): void
}

let current: PipHandle | null = null

export const pip = {
  bind(h: PipHandle) {
    current = h
  },
  unbind(h: PipHandle) {
    if (current === h) current = null
  },
  /** something changed on screen — re-perch if needed */
  notify: () => current?.notify(),
  /** a reply just finished — dart home happily */
  celebrate: () => current?.celebrate(),
  /** a message was sent — flare up */
  flare: () => current?.flareUp(),
  /** the reply's hidden <emotion> tag arrived (see src/lib/emotions.ts) */
  emote: (emotion: string) => current?.emote(emotion),
  /** a compaction started (true) or finished (false) — he sweeps up while
      the conversation is being tidied into a summary */
  tidy: (on: boolean) => current?.tidy(on),
  /** the turn fell over: "rate" (a 429) spins him dizzy, anything else
      knocks him out cold */
  mishap: (kind: "rate" | "error") => current?.mishap(kind),
  /** the sidebar drawer is sliding open (Pip may get clobbered) */
  drawerOpening: () => current?.drawerOpening(),
  /** the sidebar drawer was dismissed (Pip jets over to shove it shut) */
  drawerClosing: () => current?.drawerClosing(),
}

/* dev-only handle for poking Pip from the console:
   __pip.emote("crying"), __pip.mishap("rate"), __pip.tidy(true) — and
   engine() for driving an action directly, e.g. starting a named ring act */
if (import.meta.env.DEV)
  (window as unknown as { __pip: unknown }).__pip = {
    ...pip,
    engine: () => current,
  }
