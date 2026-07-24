import { armStroke } from "../draw/pip"
import type { PipEngine } from "../engine"
import { clamp, easeIO, lerp, n1 } from "../math"
import type { Palette } from "../palette"
import type { PipPose, RingAct, SceneProp } from "../types"

/*
 * Ring act: the high wire. Two little posts pop up either side of the home
 * ring, a rope strings between them, and Pip inches across with a balance
 * pole — wobbling, catching himself, and taking a bow at the far end.
 * Built to the axe-throw template (props implementing SceneProp + a
 * RingAct); the pole uses the act's pose/drawFront hooks so his arms go
 * out to the sides and the pole draws over him.
 */

class RopeProp implements SceneProp {
  /** load: where along the rope the weight is (0..1) and how deep it sags */
  load = -1
  sag = 0
  private t = 0
  private alpha = 1
  private dying = false

  constructor(
    private x0: number,
    private x1: number,
    private y: number,
    private h: number,
  ) {}

  step(dt: number): boolean {
    this.t = Math.min(this.t + dt, 1)
    if (this.dying) {
      this.alpha -= dt * 3.5
      if (this.alpha <= 0) return false
    }
    return true
  }

  die() {
    this.dying = true
  }

  draw(ctx: CanvasRenderingContext2D, pal: Palette, t: number) {
    const pop = clamp(this.t / 0.22, 0, 1)
    ctx.save()
    ctx.globalAlpha = this.alpha
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    /* the two posts grow out of the ring floor */
    for (const x of [this.x0, this.x1]) {
      const s = x === this.x0 ? -1 : 1
      ctx.strokeStyle = pal.woodDark
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.moveTo(x, this.y + this.h * 0.55)
      ctx.lineTo(x, this.y - this.h * pop)
      ctx.moveTo(x, this.y + this.h * 0.55)
      ctx.lineTo(x + s * 9, this.y + this.h * 0.75)
      ctx.moveTo(x, this.y + this.h * 0.55)
      ctx.lineTo(x - s * 9, this.y + this.h * 0.75)
      ctx.stroke()
      ctx.strokeStyle = pal.wood
      ctx.lineWidth = 2.2
      ctx.beginPath()
      ctx.moveTo(x, this.y + this.h * 0.5)
      ctx.lineTo(x, this.y - this.h * pop + 1)
      ctx.stroke()
    }
    /* the wire, sagging under wherever he's standing */
    const top = this.y - this.h * pop
    const mid = (this.x0 + this.x1) / 2
    const cx = this.load >= 0 ? lerp(this.x0, this.x1, this.load) : mid
    const cy = top + this.sag * 2 + (this.load >= 0 ? 0 : 3) + n1(t * 2.4) * 0.6
    ctx.strokeStyle = pal.bar
    ctx.lineWidth = 2.4
    ctx.beginPath()
    ctx.moveTo(this.x0, top)
    ctx.quadraticCurveTo(cx, cy, this.x1, top)
    ctx.stroke()
    ctx.restore()
  }
}

/** how far above the ring floor the wire is strung */
const POST_H = 26
/** his soles in unit space — the wire has to meet them exactly */
const SOLE = 0.735

export class TightropeAct implements RingAct {
  id = "rope"
  weight = 1
  private actT = 0
  private phase: "mount" | "cross" | "bow" = "mount"
  private phT = 0
  private rope: RopeProp | null = null
  private x0 = 0
  private x1 = 0
  private ropeY = 0
  private u = 0 /* fraction across */
  private sag = 0 /* how far the wire is dipping under him, px */
  private wobble = 0 /* signed lean, damped back to zero */
  private wobbleV = 0
  private nextWobble = 0
  private startY = 0

  constructor(private e: PipEngine) {}

  start() {
    const e = this.e
    this.actT = 0
    this.phT = 0
    this.phase = "mount"
    this.u = 0
    this.wobble = 0
    this.wobbleV = 0
    this.nextWobble = 0.9 + Math.random() * 0.8
    this.startY = e.py
    const Sc = e.Sc
    /* string the wire across the ring, from him to the far side */
    const dir = e.px > e.W * 0.5 ? -1 : 1
    /* keep the posts (and the pole's far end) comfortably on screen */
    const edge = clamp(Sc * 1.5, 40, e.W * 0.25)
    const span = clamp(Sc * 4.4, 90, e.W - edge * 2)
    this.x0 = clamp(e.px - dir * Sc * 0.6, edge, e.W - edge)
    this.x1 = clamp(this.x0 + dir * span, edge, e.W - edge)
    this.ropeY = e.py + Sc * SOLE - POST_H
    e.faceT = this.x1 > this.x0 ? 1 : -1
    this.rope = new RopeProp(this.x0, this.x1, this.ropeY + POST_H, POST_H)
    e.props.push(this.rope)
  }

  update(dt: number, t: number) {
    const e = this.e
    const Sc = e.Sc
    this.actT += dt
    this.phT += dt

    /* one sag figure for both him and the wire, so his soles stay on it */
    this.sag = Math.sin(clamp(this.u, 0, 1) * Math.PI) * 5
    const stand = this.ropeY + this.sag - Sc * SOLE

    if (this.phase === "mount") {
      /* hop up onto the wire */
      const k = easeIO(clamp(this.phT / 0.45, 0, 1))
      e.px = lerp(e.px, this.x0, 1 - Math.pow(0.01, dt))
      e.py = lerp(this.startY, stand, k)
      if (this.phT >= 0.45) {
        this.phase = "cross"
        this.phT = 0
      }
    } else if (this.phase === "cross") {
      /* inch across, bobbing with each shuffling step */
      this.u = clamp(this.u + dt * 0.29, 0, 1)
      e.px = lerp(this.x0, this.x1, this.u)
      e.py = stand - Math.abs(Math.sin(this.actT * 5.5)) * 1.6
      /* every so often the wire gets away from him and he has to catch it */
      this.nextWobble -= dt
      if (this.nextWobble <= 0 && this.u < 0.86) {
        this.nextWobble = 1.1 + Math.random() * 1.1
        this.wobbleV = (Math.random() < 0.5 ? -1 : 1) * (2.6 + Math.random() * 2)
        e.drops.spawn(e.px, e.py - Sc * 0.9, false, e.PAL.sweat, 22)
      }
      if (this.u >= 1) {
        this.phase = "bow"
        this.phT = 0
        e.gigPulse = 1.2
        e.flareV = 3
        for (let i = 0; i < 5; i++) e.drops.spawn(e.px, e.py, true)
      }
    } else {
      /* the far post: arms up, a little bow, then off — hold his ground,
         or the resting spot reels him back across the ring mid-bow */
      e.px = this.x1
      e.py = stand + Math.sin(this.phT * 6) * 1.2
      if (this.phT > 1.1) {
        this.cancel(true)
        e.act = ""
        e.ringActNext = 3 + Math.random() * 3
      }
    }

    /* the balance wobble: a damped spring he keeps fighting */
    this.wobbleV += -this.wobble * 26 * dt - this.wobbleV * 3.4 * dt
    this.wobble += this.wobbleV * dt
    const drift = this.phase === "cross" ? n1(t * 1.7) * 0.06 : 0
    e.tiltExtra += clamp(this.wobble * 0.12 + drift, -0.4, 0.4)
    if (this.rope) {
      this.rope.load =
        this.phase === "mount" ? 0 : (e.px - this.x0) / (this.x1 - this.x0 || 1)
      this.rope.sag = this.sag
    }
  }

  pose(pose: PipPose) {
    /* arms out on the pole — held low, clear of his face, and tipping
       against whichever way the wire has just thrown him */
    const reach = 0.86 + Math.abs(this.wobble) * 0.04
    pose.grip = { x: reach, y: 0.3 - this.wobble * 0.06 }
    pose.gripB = { x: -reach, y: 0.3 + this.wobble * 0.06 }
    if (this.phase === "cross") {
      pose.walkPh = this.actT * 5.5
      pose.effort = Math.max(pose.effort, 0.2 + Math.min(0.4, Math.abs(this.wobble) * 0.2))
    }
    if (this.phase === "bow") {
      const k = clamp(this.phT / 0.55, 0, 1)
      const b = Math.sin(k * Math.PI)
      pose.tilt += pose.face * b * 0.5
      pose.happy = true
      pose.grip = { x: 0.5, y: -0.55 }
      pose.gripB = { x: -0.5, y: -0.55 }
    }
    pose.gazeX = pose.face * 0.3
    pose.gazeY = this.phase === "cross" ? 0.35 : 0
  }

  drawFront(t: number, pose: PipPose) {
    const e = this.e
    const c = e.g
    if (!c || !pose.grip || !pose.gripB) return
    c.save()
    /* the same transform drawPip uses, so the pole sits in his hands */
    c.translate(pose.x, pose.y)
    c.rotate(pose.tilt)
    c.scale(pose.S * pose.sx * pose.face, pose.S * pose.sy)
    const g = pose.grip
    const gb = pose.gripB
    /* the pole runs through both hands, drooping against his lean */
    const droop = -this.wobble * 0.05 + n1(t * 2.2) * 0.02
    const half = 1.35
    c.save()
    c.translate((g.x + gb.x) / 2, (g.y + gb.y) / 2)
    c.rotate(Math.atan2(g.y - gb.y, g.x - gb.x) + droop)
    c.lineCap = "round"
    c.strokeStyle = e.PAL.woodDark
    c.lineWidth = 0.085
    c.beginPath()
    c.moveTo(-half, 0)
    c.lineTo(half, 0)
    c.stroke()
    c.strokeStyle = e.PAL.wood
    c.lineWidth = 0.05
    c.beginPath()
    c.moveTo(-half + 0.03, 0)
    c.lineTo(half - 0.03, 0)
    c.stroke()
    /* weighted ends */
    for (const s of [-1, 1]) {
      c.beginPath()
      c.ellipse(s * half, 0, 0.07, 0.1, 0, 0, 6.2832)
      c.fillStyle = e.PAL.steel
      c.fill()
      c.lineWidth = 0.032
      c.strokeStyle = e.PAL.steelEdge
      c.stroke()
    }
    c.restore()
    /* arms out over the pole, hands closed around it */
    armStroke(c, -0.4, 0.2, gb.x, gb.y, -0.06, e.PAL.outline, e.PAL.limb)
    armStroke(c, 0.4, 0.2, g.x, g.y, 0.06, e.PAL.outline, e.PAL.limb)
    for (const h of [g, gb]) {
      c.beginPath()
      c.arc(h.x, h.y, 0.098, 0, 6.2832)
      c.fillStyle = e.PAL.limb
      c.fill()
      c.lineWidth = 0.032
      c.strokeStyle = e.PAL.outline
      c.stroke()
    }
    c.restore()
  }

  cancel(fast: boolean) {
    this.rope?.die()
    if (!fast) this.rope = null
    this.e.windup = 0
  }
}
