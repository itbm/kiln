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
  drawerOpening(): void
  drawerClosing(): void
  sweep(on: boolean): void
  stumble(kind: string): void
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
  /** the sidebar drawer is sliding open (Pip may get clobbered) */
  drawerOpening: () => current?.drawerOpening(),
  /** the sidebar drawer was dismissed (Pip jets over to shove it shut) */
  drawerClosing: () => current?.drawerClosing(),
  /** conversation is being compacted — sweep up (true) then stop (false) */
  sweep: (on: boolean) => current?.sweep(on),
  /** a request failed — reel from it: "dizzy" (rate-limited) or "faint" */
  stumble: (kind: string) => current?.stumble(kind),
}

/* dev-only handle for poking moods from the console:
   __pip.emote("crying") */
if (import.meta.env.DEV)
  (window as unknown as { __pip: typeof pip }).__pip = pip
