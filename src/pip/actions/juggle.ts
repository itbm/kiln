import { armStroke } from "../draw/pip"
import type { PipEngine } from "../engine"
import { clamp } from "../math"
import type { PipPose, RingAct } from "../types"

/*
 * Ring act: juggling embers. Three glowing coals go up in a three-ball
 * cascade, trailing sparks, until he snatches them out of the air. Built to
 * the axe-throw template, but the embers ride his own unit space rather
 * than the scene, so they lean with him — the act's pose/drawFront hooks
 * put his hands under the pattern and draw the coals over his body.
 */

const BALLS = 3
/** seconds per throw; each ember is a third of a cycle behind the last */
const PERIOD = 0.46
/** how high above his hands the cascade peaks, in unit space — high enough
    to clear his own flame, or the coals get lost in it */
const APEX = 2.05
const HAND_X = 0.56
const HAND_Y = 0.08

interface Ember {
  x: number
  y: number
  /** 0 at the throw, 1 at the catch — drives the glow's flicker */
  p: number
}

export class JuggleAct implements RingAct {
  id = "juggle"
  weight = 1
  private actT = 0
  private dur = 3.4
  private embers: Ember[] = []
  private fade = 0 /* 1 while the pattern is up, 0 once caught */

  constructor(private e: PipEngine) {}

  start() {
    const e = this.e
    this.actT = 0
    this.dur = 3.2 + Math.random() * 1.6
    this.fade = 0
    this.embers = []
    e.faceT = Math.random() < 0.5 ? -1 : 1
    e.flareV = 2.4
    for (let i = 0; i < 4; i++) e.drops.spawn(e.px, e.py, true)
  }

  /** where ember i is right now, in his unit space */
  private at(i: number, tt: number): Ember {
    const ph = tt / PERIOD + (i * 1) / BALLS
    const cyc = Math.floor(ph)
    const p = ph - cyc
    /* odd throws go right-to-left, even ones left-to-right — a cascade */
    const d = cyc % 2 === 0 ? 1 : -1
    return {
      x: -d * HAND_X + d * 2 * HAND_X * p,
      y: HAND_Y - Math.sin(p * Math.PI) * APEX,
      p,
    }
  }

  update(dt: number) {
    const e = this.e
    this.actT += dt
    /* the first cycle spools up, the last one lands in his hands */
    this.fade = clamp(Math.min(this.actT / 0.3, (this.dur - this.actT) / 0.25), 0, 1)
    this.embers = []
    for (let i = 0; i < BALLS; i++) this.embers.push(this.at(i, this.actT))
    /* sparks peel off the coals as they fly */
    const Sc = e.Sc
    for (const em of this.embers) {
      if (Math.random() < dt * 9 * this.fade)
        e.drops.spawn(e.px + em.x * Sc * e.face, e.py + em.y * Sc, false, null, 14)
    }
    if (Math.random() < dt * 2) e.flareV = Math.max(e.flareV, 1.8)
    if (this.actT >= this.dur) {
      /* caught, all three at once, with a puff of sparks off both hands */
      for (const s of [-1, 1])
        for (let i = 0; i < 4; i++)
          e.drops.spawn(e.px + s * HAND_X * Sc, e.py + HAND_Y * Sc, true)
      e.gigPulse = 1.1
      e.flareV = 3
      this.cancel(true)
      e.act = ""
      e.ringActNext = 2.5 + Math.random() * 3
    }
  }

  pose(pose: PipPose) {
    /* hands under the pattern, dipping alternately as they catch */
    const beat = (this.actT / PERIOD) * Math.PI * 2
    pose.grip = { x: HAND_X, y: HAND_Y + Math.sin(beat) * 0.09 }
    pose.gripB = { x: -HAND_X, y: HAND_Y + Math.sin(beat + Math.PI) * 0.09 }
    /* eyes up on the apex, head bobbing along with the throws */
    pose.gazeY = -0.75
    pose.gazeX *= 0.3
    pose.y -= Math.abs(Math.sin(beat)) * pose.S * 0.012
  }

  drawFront(t: number, pose: PipPose) {
    const e = this.e
    const c = e.g
    if (!c || !pose.grip || !pose.gripB) return
    c.save()
    /* his transform, so the coals lean with him */
    c.translate(pose.x, pose.y)
    c.rotate(pose.tilt)
    c.scale(pose.S * pose.sx * pose.face, pose.S * pose.sy)
    for (const em of this.embers) {
      const r = 0.13 * (0.85 + 0.15 * Math.sin(t * 21 + em.p * 6))
      const k = this.fade
      if (k < 0.02) continue
      c.globalAlpha = k
      const g = c.createRadialGradient(em.x, em.y, r * 0.15, em.x, em.y, r * 2.6)
      g.addColorStop(0, e.PAL.jetCore)
      g.addColorStop(0.35, e.PAL.jetMid)
      g.addColorStop(1, "rgba(240,74,14,0)")
      c.fillStyle = g
      c.beginPath()
      c.arc(em.x, em.y, r * 2.6, 0, 6.2832)
      c.fill()
      c.beginPath()
      c.arc(em.x, em.y, r, 0, 6.2832)
      c.fillStyle = e.PAL.jetMid
      c.fill()
      c.lineWidth = 0.028
      c.strokeStyle = e.PAL.jetEdge
      c.stroke()
      c.beginPath()
      c.arc(em.x - r * 0.28, em.y - r * 0.28, r * 0.4, 0, 6.2832)
      c.fillStyle = e.PAL.core
      c.fill()
    }
    c.globalAlpha = 1
    /* arms up under the cascade, closed hands over the coals they hold */
    const g = pose.grip
    const gb = pose.gripB
    armStroke(c, -0.4, 0.2, gb.x, gb.y, -0.14, e.PAL.outline, e.PAL.limb)
    armStroke(c, 0.4, 0.2, g.x, g.y, 0.14, e.PAL.outline, e.PAL.limb)
    c.restore()
  }

  cancel(fast: boolean) {
    this.embers = []
    this.fade = 0
    if (!fast) this.actT = this.dur
    this.e.windup = 0
  }
}
