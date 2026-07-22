import type { PipEngine } from "../engine"
import { clamp, easeIO, easeOutBack } from "../math"
import type { PipAction, PipPose } from "../types"

/**
 * When a request falls over, Pip does too — a physical reaction, not just a
 * mood tag. Two flavours, chosen by the engine from the error (engine.stumble):
 *
 *  - "dizzy": the rate limit — he's been asked too much, too fast, so he
 *    reels on the spot, eyes swimming, a ring of stars circling his head
 *    before he shakes it off.
 *  - "faint": a hard stream error clean knocks him out — he keels over toward
 *    the way he faced, lies stunned seeing stars, then springs back upright.
 *
 * Either way he recovers on his own and re-perches. Entered from the bus, so
 * begin() hands the previous mode back itself.
 */
export class StumbleAction implements PipAction {
  id = "stumble"
  private kind: "dizzy" | "faint" = "dizzy"
  private t = 0
  private starPh = 0
  private starsOn = false

  constructor(private e: PipEngine) {}

  private get dur() {
    return this.kind === "dizzy" ? 2.2 : 2.4
  }

  begin(kind: "dizzy" | "faint") {
    const e = this.e
    e.leaveMode(true)
    e.clearAct(true)
    e.mode = "stumble"
    this.kind = kind
    this.t = 0
    this.starPh = 0
    this.starsOn = false
    /* a hard error slumps the flame; a rate-limit just rattles him */
    e.flareV = kind === "faint" ? -1.6 : 0.4
    for (let i = 0; i < 5; i++) e.drops.spawn(e.px, e.py, true)
  }

  update(dt: number) {
    const e = this.e
    this.t += dt
    this.starPh += dt * (this.kind === "dizzy" ? 3.2 : 2.4)
    this.starsOn =
      this.kind === "dizzy"
        ? this.t > 0.25 && this.t < this.dur - 0.4
        : this.t > 0.5 && this.t < 2.0
    /* keep his flame trail alive (the engine only auto-spawns at rest) */
    if (Math.random() < dt * 1.2) e.drops.spawn(e.px, e.py - e.Sc * 1.05, false)
    /* dizzy: the odd woozy bead of sweat */
    if (this.kind === "dizzy" && Math.random() < dt * 1.6)
      e.drops.spawn(e.px + e.face * e.Sc * 0.4, e.py - e.Sc * 0.2, false, e.PAL.sweat, 12)
    if (this.t >= this.dur) this.recover()
  }

  private recover() {
    const e = this.e
    e.flareV = 2.4 /* the flame catches again */
    e.startDart(e.pickNext())
  }

  /** a four-point sparkle, drawn in screen space so it orbits level above
      his head no matter how far he's toppled */
  private drawStar(c: CanvasRenderingContext2D, x: number, y: number, r: number, a: number) {
    c.save()
    c.globalAlpha = a
    c.translate(x, y)
    c.beginPath()
    c.moveTo(0, -r)
    c.quadraticCurveTo(0.16 * r, -0.16 * r, r, 0)
    c.quadraticCurveTo(0.16 * r, 0.16 * r, 0, r)
    c.quadraticCurveTo(-0.16 * r, 0.16 * r, -r, 0)
    c.quadraticCurveTo(-0.16 * r, -0.16 * r, 0, -r)
    c.closePath()
    c.fillStyle = "#FFE07A"
    c.fill()
    c.globalAlpha = 1
    c.restore()
  }

  drawFront(_t: number, pose: PipPose) {
    const e = this.e
    const c = e.g
    if (!c || e.mode !== "stumble" || !this.starsOn) return
    const Sc = e.Sc
    /* orbit centre: above his upright head when dizzy; above his fallen head
       (shifted the way he toppled) when out cold */
    const cx = pose.x + (this.kind === "faint" ? e.face * Sc * 0.55 : 0)
    const cy = pose.y - Sc * (this.kind === "faint" ? 0.35 : 1.15)
    const rr = Sc * 0.5
    for (let i = 0; i < 3; i++) {
      const a = this.starPh + (i * Math.PI * 2) / 3
      const x = cx + Math.cos(a) * rr
      const y = cy + Math.sin(a) * rr * 0.42 /* flattened orbit */
      const tw = 0.65 + 0.35 * Math.sin(this.starPh * 3 + i * 2)
      this.drawStar(c, x, y, Sc * 0.12 * tw, 0.9)
    }
  }

  pose(pose: PipPose, _t: number) {
    const e = this.e
    const Sc = e.Sc
    /* no giggling or smiling through a crash */
    pose.happy = false
    pose.giggle = 0
    pose.startled = false
    if (this.kind === "dizzy") {
      /* recovers over the last stretch, so the wobble eases out */
      const amp = 1 - clamp((this.t - (this.dur - 0.6)) / 0.6, 0, 1)
      pose.tilt += Math.sin(this.t * 7) * 0.26 * amp
      pose.x += Math.sin(this.t * 4.3) * Sc * 0.045 * amp
      pose.gazeX = Math.sin(this.t * 5) * 0.8 * amp
      pose.gazeY = 0.1
      pose.lid = Math.min(pose.lid, 0.5)
      pose.sy *= 1 - 0.03 * amp
      return
    }
    /* faint: topple → out cold → spring back up */
    const T = this.t
    if (T < 0.5) {
      const k = easeIO(clamp(T / 0.5, 0, 1))
      pose.tilt += e.face * 1.4 * k
      pose.y += Sc * 0.5 * k
      pose.sx *= 1 + 0.18 * k
      pose.sy *= 1 - 0.34 * k
      pose.gazeY = 0.4
      pose.lid = Math.min(pose.lid, 1 - 0.75 * k)
    } else if (T < 1.8) {
      pose.tilt += e.face * 1.4 + Math.sin(T * 20) * 0.02 /* out, with a twitch */
      pose.y += Sc * 0.5
      pose.sx *= 1.18
      pose.sy *= 0.66
      pose.lid = 0.12
      pose.gazeY = 0.3
    } else {
      const k = clamp((T - 1.8) / 0.6, 0, 1)
      const b = easeOutBack(k) /* overshoots → a little pop upright */
      pose.tilt += e.face * 1.4 * (1 - b)
      pose.y += Sc * 0.5 * (1 - b)
      pose.sx *= 1 + 0.18 * (1 - k)
      pose.sy *= 1 - 0.34 * (1 - k)
      pose.lid = Math.min(pose.lid, 0.4 + 0.6 * k)
    }
  }
}
