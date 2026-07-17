import type { ComponentType } from "react"

/**
 * Visual capabilities a theme opts into. Components consult these flags —
 * never a theme id — so future themes (a Christmas theme with snow, say)
 * compose from the same switches without touching component code.
 */
export interface ThemeFeatures {
  /** Pip the stuntflame lives in this theme (can still be muted in Settings) */
  pip?: boolean
  /** 2px ember gradient hairline across the top of each screen */
  topline?: boolean
  /** soft radial glow washes behind the main surface */
  glow?: boolean
  /** branded chrome: wordmark header, spyhole brand dot, model subtitle */
  brandChrome?: boolean
  /** greeting with Pip's ring perch, gradient full stop and privacy tags */
  brandGreeting?: boolean
  /** "every byte stays on this phone" hint under the composer */
  composerHint?: boolean
}

export interface AppThemeDef {
  /** stable id persisted in settings */
  id: string
  /** name shown in the Settings picker */
  name: string
  /** short blurb for the Settings picker */
  description: string
  /**
   * class applied to <html>. Always "theme-<id>" — the pre-paint script in
   * index.html derives it the same way to avoid a flash of the wrong theme.
   */
  htmlClass: string
  /** browser chrome colour (meta theme-color) per colour scheme */
  themeColor: { light: string; dark: string }
  features: ThemeFeatures
  /**
   * Optional full-screen decorative overlay rendered above the app
   * (pointer-events: none) — e.g. falling snow for a Christmas theme.
   */
  Overlay?: ComponentType
}
