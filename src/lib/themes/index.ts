import { classic } from "./classic"
import { ember } from "./ember"
import type { AppThemeDef } from "./types"

export type { AppThemeDef, ThemeFeatures } from "./types"

/**
 * Every installable theme, in the order the Settings picker shows them.
 * Adding a theme = one new file in this folder + one entry here
 * (plus its token block in src/themes/<id>.css).
 */
export const THEMES: AppThemeDef[] = [ember, classic]

export const DEFAULT_THEME_ID = ember.id

export function getTheme(id: string | undefined | null): AppThemeDef {
  return THEMES.find((t) => t.id === id) ?? ember
}
