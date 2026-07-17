import type { AppThemeDef } from "./types"

/**
 * The kiln-brand theme: char-black (or bone-white) surfaces, ember gradient
 * accents, Unbounded/Geist type — and Pip, the resident stuntflame.
 * Token values live in src/themes/ember.css.
 */
export const ember: AppThemeDef = {
  id: "ember",
  name: "Ember",
  description: "Char & ember brand look, with Pip the stuntflame",
  htmlClass: "theme-ember",
  themeColor: { light: "#FAF7F1", dark: "#0C0A09" },
  features: {
    pip: true,
    topline: true,
    glow: true,
    brandChrome: true,
    brandGreeting: true,
    composerHint: true,
  },
}
