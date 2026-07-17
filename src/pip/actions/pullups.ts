import { rectOfEl, zoneResolve } from "../anchors"
import type { PipEngine } from "../engine"
import { clamp, easeIO, lerp } from "../math"
import type { PipAction, PipPose } from "../types"

const headerEl = () => document.querySelector('[data-pip-spot="header"]')

/**
 * Pull-ups on an invisible bar under the header. He speeds up when you
 * hover close (showing off) and sweats near the top of each rep.
 */
export class PullupsAction implements PipAction {
  id = "pullup"
  private puT = 0
  private puReps = 4

  constructor(private e: PipEngine) {}

  begin() {
    const e = this.e
    e.mode = "pullup"
    this.puT = 0
    e.puK = 0
    e.puEffort = 0
    this.puReps = 3 + Math.floor(Math.random() * 3)
    e.faceT = Math.random() < 0.5 ? -1 : 1
  }

  update(dt: number) {
    const e = this.e
    const hb = rectOfEl(headerEl())
    if (!hb) {
      e.startDart(e.pickNext())
      return
    }
    const Sc = e.Sc
    const barY = hb.bottom + 1
    const bp = e.spot ? zoneResolve(e.spot, e.env) : null
    if (bp) e.px += (bp.x - e.px) * (1 - Math.pow(0.01, dt))
    e.scale += (0.82 - e.scale) * (1 - Math.pow(0.01, dt))
    const cyc = 1.2
    this.puT += dt * (e.veryNear ? 1.35 : 1)
    const rep = Math.floor(this.puT / cyc)
    const frac = (this.puT % cyc) / cyc
    e.puK =
      frac < 0.42
        ? easeIO(frac / 0.42)
        : frac < 0.6
          ? 1
          : easeIO(1 - (frac - 0.6) / 0.4)
    e.puEffort = e.puK
    const hangY = barY + Sc * 1.02
    const topY = barY + Sc * 0.5
    e.py = lerp(hangY, topY, e.puK)
    if (e.puK > 0.94 && Math.random() < dt * 7)
      e.drops.spawn(
        e.px + (Math.random() - 0.5) * Sc * 0.8,
        e.py - Sc * 0.4,
        false,
        e.PAL.sweat,
        40,
      )
    if (rep >= this.puReps) {
      e.actions.fall.begin()
      for (let i = 0; i < 4; i++) e.drops.spawn(e.px, e.py, true)
    }
  }

  draw() {
    const e = this.e
    const c = e.g
    const hb = rectOfEl(headerEl())
    if (!c || !hb) return
    const Sc = e.Sc
    c.strokeStyle = e.PAL.bar
    c.lineWidth = 4
    c.lineCap = "round"
    c.beginPath()
    c.moveTo(e.px - Sc * 0.95, hb.bottom + 1)
    c.lineTo(e.px + Sc * 0.95, hb.bottom + 1)
    c.stroke()
  }

  pose(pose: PipPose) {
    const e = this.e
    const hb = rectOfEl(headerEl())
    if (hb)
      pose.pull = { grip: clamp((hb.bottom + 1 - e.py) / e.Sc, -1.55, -0.35) }
  }
}
