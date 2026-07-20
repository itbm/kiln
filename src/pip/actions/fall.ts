import { rectOfEl } from "../anchors"
import type { PipEngine } from "../engine"
import { clamp } from "../math"
import type { PipAction, Spot } from "../types"

/** Losing his grip: tumble off the bar and land on the composer ledge. */
export class FallAction implements PipAction {
  id = "fall"
  private fallV = 0
  private fallT = 0

  constructor(private e: PipEngine) {}

  begin() {
    const e = this.e
    e.mode = "fall"
    this.fallV = 0
    this.fallT = 0
    e.clearAct(true)
  }

  update(dt: number) {
    const e = this.e
    const Sc = e.Sc
    this.fallT += dt
    this.fallV += 1500 * dt
    e.py += this.fallV * dt
    e.tiltExtra += Math.sin(this.fallT * 14) * 0.06
    const fc = rectOfEl(document.querySelector('[data-pip-spot="composer"]'))
    const flY = fc ? fc.top - Sc * 0.5 : e.H - 60
    if (e.py >= flY) {
      e.py = flY
      e.flareV = 2.6
      for (let i = 0; i < 4; i++) e.drops.spawn(e.px, e.py + Sc * 0.5, false)
      const fx = fc ? clamp((e.px - fc.left) / fc.width, 0.1, 0.85) : 0.5
      const spot: Spot = {
        id: "floorZone",
        zone: "floor",
        ride: true,
        w: 2,
        fx,
        calm: !document.querySelector('[data-pip-spot="ring"]'),
        x: e.px,
        y: e.py,
      }
      e.spot = spot
      e.actions.patrol.beginShort()
    } else if (this.fallT > 0.9) {
      e.startDart(e.pickNext())
    }
  }
}
