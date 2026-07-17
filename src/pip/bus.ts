/**
 * Loose coupling between the app and Pip: components call pip.* freely;
 * every call is a safe no-op unless a PipCanvas is mounted (Pip off in
 * Settings, Classic theme, reduced motion, etc.).
 */
export interface PipHandle {
  notify(): void
  celebrate(): void
  flareUp(): void
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
  /** the sidebar drawer is sliding open (Pip may get clobbered) */
  drawerOpening: () => current?.drawerOpening(),
  /** the sidebar drawer was dismissed (Pip jets over to shove it shut) */
  drawerClosing: () => current?.drawerClosing(),
}
