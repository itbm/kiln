import type { PipAccessory } from "../types"

/**
 * Cosmetics drawn on top of Pip (hats, scarves, held items…).
 *
 * To dress Pip up — say, a Santa hat for a Christmas theme — add a file
 * here exporting a PipAccessory and push it onto this list (a seasonal
 * theme could do so conditionally). The draw callback runs in Pip's local
 * unit space: origin at his middle, body roughly -1.2 (crown) to +0.8
 * (feet), positive y downward. Example:
 *
 *   // accessories/santa-hat.ts
 *   export const santaHat: PipAccessory = {
 *     id: "santa-hat",
 *     draw(ctx) {
 *       ctx.beginPath()
 *       ctx.moveTo(-0.34, -0.62)
 *       ctx.quadraticCurveTo(0, -1.25, 0.38, -0.66)
 *       ctx.closePath()
 *       ctx.fillStyle = "#D42B2B"
 *       ctx.fill()
 *       // …white trim + bobble
 *     },
 *   }
 */
export const accessories: PipAccessory[] = []
