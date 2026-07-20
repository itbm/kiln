import { drawerEl, rectOfEl } from "../anchors"
import type { PipEngine } from "../engine"
import { clamp, dist, easeIO, lerp, n1 } from "../math"
import type { PipAction } from "../types"

/**
 * When the sidebar is dismissed, Pip straps on the jetpack, flies to its
 * edge and shoves it shut, riding the door out — then peels away with a
 * happy flourish. Owns both the "jet" (flight) and "push" (shoving) modes.
 */
export class JetCloseAction implements PipAction {
  id = "jet"
  private jetT = 0
  private jetDur = 0.4
  private pushT = 0
  private from = { x: 0, y: 0 }
  private to = { x: 0, y: 0 }
  private busyFlag = false

  constructor(private e: PipEngine) {}

  /** abort mid-flight (e.g. the drawer re-opens on top of him) */
  cancel() {
    const e = this.e
    this.busyFlag = false
    if (e.mode === "jet" || e.mode === "push") {
      e.mode = "rest"
      e.restT = 0
      e.restDur = 0.15
      e.spot = { x: e.px, y: e.py, s: e.scale, ride: false, w: 1 }
    }
  }

  beginClose(): boolean {
    const e = this.e
    if (e.reduceMotion || this.busyFlag) return false
    const dr = rectOfEl(drawerEl())
    if (!dr) return false
    e.leaveMode(true)
    this.busyFlag = true
    e.clearAct(true)
    e.mode = "jet"
    this.jetT = 0
    this.from = { x: e.px, y: e.py }
    this.to = {
      x: Math.min(dr.right + e.S0 * 0.62, e.W - 30),
      y: clamp(e.H * 0.44, 90, e.H - 120),
    }
    this.jetDur = clamp(
      dist(e.px, e.py, this.to.x, this.to.y) / 1400,
      0.26,
      0.5,
    )
    e.faceT = this.to.x > e.px ? 1 : -1
    return true
  }

  update(dt: number, t: number) {
    const e = this.e
    const Sc = e.Sc
    if (e.mode === "jet") {
      this.jetT += dt
      const jk = easeIO(clamp(this.jetT / this.jetDur, 0, 1))
      e.px = lerp(this.from.x, this.to.x, jk) + n1(t * 22) * 2
      e.py = lerp(this.from.y, this.to.y, jk) + n1(t * 18 + 4) * 2
      e.scale += (0.92 - e.scale) * (1 - Math.pow(0.01, dt))
      if (Math.random() < dt * 40)
        e.drops.spawn(e.px - e.face * Sc * 0.7, e.py + Sc * 0.35, false, null, 10)
      if (jk >= 1) {
        e.mode = "push"
        this.pushT = 0
        e.faceT = -1
      }
      return
    }
    /* push: ride the closing door out, tracking its live edge */
    this.pushT += dt
    const dr = rectOfEl(drawerEl())
    if (!dr || dr.right <= 2 || this.pushT > 0.9) {
      this.finish()
      return
    }
    e.px += (dr.right + Sc * 0.55 - e.px) * (1 - Math.pow(0.0001, dt))
    e.py += (this.to.y - e.py) * (1 - Math.pow(0.01, dt))
    e.tiltExtra += 0.15 * e.face * -1
    if (Math.random() < dt * 30)
      e.drops.spawn(e.px + Sc * 0.4, e.py + Sc * 0.55, false, null, 8)
  }

  private finish() {
    const e = this.e
    this.busyFlag = false
    e.flareV = 3
    for (let i = 0; i < 6; i++) e.drops.spawn(e.px, e.py, true)
    e.startDart({
      x: clamp(e.px + 80, 40, e.W - 40),
      y: e.py - 26,
      s: 0.92,
      ride: false,
      happy: true,
      w: 1,
    })
  }
}
