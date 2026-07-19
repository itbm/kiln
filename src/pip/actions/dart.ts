import { resolveSpot } from "../anchors"
import type { PipEngine } from "../engine"
import { clamp, dist, easeIO, lerp } from "../math"
import type { PipAction, Spot } from "../types"

/** The hop between perches: a quick arced dash with a spark trail. */
export class DartAction implements PipAction {
  id = "dart"
  private from = { x: 0, y: 0 }
  private ctl = { x: 0, y: 0 }
  private T = 0
  private dur = 0.7

  constructor(private e: PipEngine) {}

  begin(target: Spot | null) {
    const e = this.e
    if (!target) return
    e.clearAct(true)
    this.from = { x: e.px, y: e.py }
    e.spot = target
    e.mode = "dart"
    this.T = 0
    const p1 = resolveSpot(target, e.env) ?? target
    const d = dist(e.px, e.py, p1.x, p1.y)
    this.dur = clamp(d / 1100, 0.4, 0.9)
    const mx = (e.px + p1.x) / 2
    const my = (e.py + p1.y) / 2
    const nx = -(p1.y - e.py) / (d || 1)
    const ny = (p1.x - e.px) / (d || 1)
    const bulge = (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 80) - 30
    this.ctl = { x: mx + nx * bulge, y: my + ny * bulge - 30 }
    if (target.calm) {
      /* hops along the composer ledge stay low, slow and always arc up —
         no swooping over the conversation (or under, into the keyboard) */
      this.dur = clamp(d / 700, 0.45, 0.9)
      this.ctl = { x: mx, y: my - (24 + Math.random() * 30) }
    }
    if (Math.abs(p1.x - e.px) > 50) e.faceT = p1.x > e.px ? 1 : -1
  }

  update(dt: number) {
    const e = this.e
    this.T += dt
    const k = easeIO(clamp(this.T / this.dur, 0, 1))
    const sp = e.spot
    const p1 = (sp && resolveSpot(sp, e.env)) ?? sp ?? { x: e.px, y: e.py, s: 1 }
    e.px = lerp(lerp(this.from.x, this.ctl.x, k), lerp(this.ctl.x, p1.x, k), k)
    e.py = lerp(lerp(this.from.y, this.ctl.y, k), lerp(this.ctl.y, p1.y, k), k)
    e.scale += ((p1.s || 1) - e.scale) * (1 - Math.pow(0.01, dt))
    if (Math.random() < dt * 22) e.drops.spawn(e.px, e.py, false)
    if (this.T >= this.dur) {
      e.px = p1.x
      e.py = p1.y
      this.land()
    }
  }

  private land() {
    const e = this.e
    e.flareV = 2.2
    for (let i = 0; i < 3; i++)
      e.drops.spawn(e.px, e.py + e.scale * e.S0 * 0.4, false)
    if (e.spot?.zone === "floor") {
      e.actions.patrol.begin()
      return
    }
    if (e.spot?.zone === "bar") {
      e.actions.pullups.begin()
      return
    }
    e.enterRest()
  }
}
