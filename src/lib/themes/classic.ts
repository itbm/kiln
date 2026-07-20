import type { AppThemeDef } from "./types"

/**
 * The original Kiln look — warm cream and clay. No brand chrome, but Pip
 * still lives here (he's app furniture, not Ember furniture — switching
 * theme shouldn't vanish him; the Settings toggle does that).
 */
export const classic: AppThemeDef = {
  id: "classic",
  name: "Classic",
  description: "The original warm cream & clay look",
  htmlClass: "theme-classic",
  themeColor: { light: "#faf9f5", dark: "#262624" },
  features: { pip: true },
}
