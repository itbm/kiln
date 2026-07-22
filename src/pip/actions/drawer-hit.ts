import { rectOfEl } from "../anchors"
import type { PipEngine } from "../engine"
import type { PipAction } from "../types"

/**
 * Clobbered by the opening sidebar: launched across the screen, a bounce
 * or two, then he sits there glaring back at the door, properly cross
 * (the anger envelope smoulders for a couple of seconds).
 */
export class DrawerHitAction implements PipAction {
  id = "hit"
  private vx = 0
  private vy = 0
  private tiltV = 0
  private bounces = 0

  constructor(private e: PipEngine) {}

  begin() {
    const e = this.e
    if (e.mode === "hit") return
    e.leaveMode(true)
    e.mode = "hit"
    e.clearAct(true)
    e.hitT = 0
    this.vx = 560 + Math.random() * 160
    this.vy = -300 - Math.random() * 120
    this.tiltV = (Math.random() < 0.5 ? -1 : 1) * (9 + Math.random() * 5)
    e.tiltO = 0
    this.bounces = 0
    e.anger = 1
    e.angerHold = 2.4
    e.eepT = -1
    e.hide = 0
    e.faceT = -1 /* glaring back at the door */
    for (let i = 0; i < 8; i++) e.drops.spawn(e.px, e.py, true)
  }

  update(dt: number) {
    const e = this.e
    const Sc = e.Sc
    e.hitT += dt
    this.vy += 1300 * dt
    e.px += this.vx * dt
    e.py += this.vy * dt
    e.tiltO += this.tiltV * dt
    this.tiltV *= 1 - dt * 1.4
    /* both side walls bounce — with only the right one, a fast ricochet
       used to carry him clean off the left edge of the screen (he'd even
       come to rest out there, invisible, until the next dart) */
    if (e.px > e.W - 26 && this.vx > 0) {
      e.px = e.W - 26
      this.vx *= -0.45
    } else if (e.px < 26 && this.vx < 0) {
      e.px = 26
      this.vx *= -0.45
    }
    /* and launched from a high perch, the arc must not clear the top —
       keep his flame tip on screen (matters on short/landscape viewports) */
    if (e.py < Sc * 1.2 && this.vy < 0) {
      e.py = Sc * 1.2
      this.vy *= -0.3
    }
    const hc = rectOfEl(document.querySelector('[data-pip-spot="composer"]'))
    const hFloor = hc ? hc.top - Sc * 0.5 : e.H - 70
    if (e.py >= hFloor) {
      e.py = hFloor
      if (Math.abs(this.vy) > 150) {
        this.vy *= -0.38
        this.vx *= 0.72
        this.tiltV *= 0.55
        this.bounces++
        for (let i = 0; i < 3; i++) e.drops.spawn(e.px, e.py + Sc * 0.4, false)
      } else {
        this.vy = 0
        this.vx *= 1 - dt * 4
        if (Math.abs(this.vx) < 40) {
          e.mode = "rest"
          e.restT = 0
          e.restDur = 2
          e.spot = { x: e.px, y: e.py, s: e.scale, ride: false, w: 1 }
          e.faceT = -1
          e.hitT = 0
        }
      }
    }
  }
}
