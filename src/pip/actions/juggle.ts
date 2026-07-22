import type { PipEngine } from "../engine"
import { lerp } from "../math"
import type { Palette } from "../palette"
import type { RingAct, SceneProp } from "../types"

/*
 * A home-ring act in the axe-throw mould (see axe-throw.ts for the template):
 * a short performance driven by SceneProps plus nudges to Pip's shared pose
 * (here e.windup bobs his throwing hand). Pip juggles three glowing embers in
 * a lazy cascade over his head — his flame's offcuts, kept airborne.
 */

/** One glowing ember; the act flies it, the prop just draws it (with a
    little comet trail of where it's been). */
class EmberProp implements SceneProp {
  x = 0
  y = 0
  alpha = 1
  private dying = false
  private trail: { x: number; y: number }[] = []

  constructor(
    private size: number,
    private seed: number,
  ) {}

  step(dt: number): boolean {
    this.trail.push({ x: this.x, y: this.y })
    if (this.trail.length > 6) this.trail.shift()
    if (this.dying) {
      this.alpha -= dt * 4
      if (this.alpha <= 0) return false
    }
    return true
  }

  die() {
    this.dying = true
  }

  draw(ctx: CanvasRenderingContext2D, pal: Palette, t: number) {
    const r = this.size * 0.16
    /* trail */
    for (let i = 0; i < this.trail.length; i++) {
      const p = this.trail[i]
      const k = i / this.trail.length
      ctx.globalAlpha = this.alpha * k * 0.45
      ctx.beginPath()
      ctx.arc(p.x, p.y, r * (0.3 + k * 0.5), 0, 6.2832)
      ctx.fillStyle = pal.jetMid
      ctx.fill()
    }
    const flick = 1 + Math.sin(t * 18 + this.seed) * 0.12
    /* soft glow */
    ctx.globalAlpha = this.alpha * 0.3
    ctx.beginPath()
    ctx.arc(this.x, this.y, r * 2.2 * flick, 0, 6.2832)
    ctx.fillStyle = pal.jetEdge
    ctx.fill()
    /* molten core */
    ctx.globalAlpha = this.alpha
    const g = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, r * flick)
    g.addColorStop(0, pal.jetCore)
    g.addColorStop(0.5, pal.jetMid)
    g.addColorStop(1, pal.jetEdge)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(this.x, this.y, r * flick, 0, 6.2832)
    ctx.fill()
    ctx.globalAlpha = 1
  }
}

export class JuggleAct implements RingAct {
  id = "juggle"
  weight = 1
  private actT = 0
  private embers: EmberProp[] = []

  constructor(private e: PipEngine) {}

  start() {
    const e = this.e
    this.actT = 0
    this.embers = []
    const size = e.Sc
    for (let i = 0; i < 3; i++) {
      const em = new EmberProp(size, i * 2.1)
      this.embers.push(em)
      e.props.push(em)
    }
    e.faceT = e.px < e.W * 0.5 ? 1 : -1 /* face into the room */
  }

  update(dt: number) {
    const e = this.e
    this.actT += dt
    const Sc = e.Sc
    const period = 0.9 /* seconds per ember around the loop */
    /* keep the whole cascade above his flame crown so every ember stays in
       view — dip it into his body and two of the three vanish behind him */
    const baseY = e.py - Sc * 1.6
    const half = Sc * 0.55
    const lift = Sc * 0.6
    const cx = e.px
    /* three embers on one shared loop, offset by a third: up-and-over on the
       front half (the tall crossing arc), a shallow catch-across on the rear */
    for (let i = 0; i < 3; i++) {
      const s = (this.actT / period + i / 3) % 1
      const em = this.embers[i]
      if (s < 0.5) {
        const k = s / 0.5
        em.x = lerp(cx + half, cx - half, k)
        em.y = baseY - Math.sin(k * Math.PI) * lift
      } else {
        const k = (s - 0.5) / 0.5
        em.x = lerp(cx - half, cx + half, k)
        em.y = baseY + Math.sin(k * Math.PI) * Sc * 0.14
      }
    }
    /* his throwing hand bobs in time; a touch of body English */
    e.windup =
      0.4 + 0.35 * (0.5 + 0.5 * Math.sin((this.actT / period) * Math.PI * 3))
    e.tiltExtra += Math.sin(this.actT * 6) * 0.02
    if (this.actT > 3.6) {
      this.cancel(true)
      e.act = ""
      e.windup = 0
      e.gigPulse = 0.6 /* chuffed with himself */
      e.ringActNext = 2.5 + Math.random() * 3
    }
  }

  cancel(fast: boolean) {
    for (const em of this.embers) em.die()
    if (!fast) this.embers = []
    this.e.windup = 0
  }
}
