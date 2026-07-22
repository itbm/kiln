import { clamp } from "../math"
import type { PipEngine } from "../engine"
import type { Palette } from "../palette"
import type { RingAct, SceneProp } from "../types"

/*
 * A home-ring act cut to the axe-throw template (axe-throw.ts): SceneProps for
 * the kit plus small nudges to Pip's shared pose. A wire strings itself across
 * beneath his feet, a balance pole appears in his grip, and he teeters his way
 * along it — the pole see-sawing to catch every wobble.
 */

/** the wire and its two end posts; dips under Pip's weight and bounces */
class RopeProp implements SceneProp {
  sagX: number
  bounce = 0
  private alpha = 1
  private dying = false

  constructor(
    private cx: number,
    private y: number,
    private span: number,
  ) {
    this.sagX = cx
  }

  step(dt: number): boolean {
    if (this.dying) {
      this.alpha -= dt * 3.5
      if (this.alpha <= 0) return false
    }
    return true
  }

  die() {
    this.dying = true
  }

  draw(ctx: CanvasRenderingContext2D, pal: Palette) {
    const L = this.cx - this.span
    const R = this.cx + this.span
    ctx.save()
    ctx.globalAlpha = this.alpha
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    /* end posts with a little foot */
    ctx.strokeStyle = pal.woodDark
    ctx.lineWidth = 3.4
    for (const px of [L, R]) {
      ctx.beginPath()
      ctx.moveTo(px, this.y)
      ctx.lineTo(px, this.y + 22)
      ctx.stroke()
      ctx.lineWidth = 2.6
      ctx.beginPath()
      ctx.moveTo(px - 7, this.y + 22)
      ctx.lineTo(px + 7, this.y + 22)
      ctx.stroke()
      ctx.lineWidth = 3.4
    }
    /* the wire: two taut spans meeting at the dip under his feet */
    const sx = clamp(this.sagX, L + 8, R - 8)
    const dip = 5 + this.bounce
    ctx.strokeStyle = pal.bar
    ctx.lineWidth = 1.7
    ctx.beginPath()
    ctx.moveTo(L, this.y)
    ctx.quadraticCurveTo((L + sx) / 2, this.y + dip * 0.5, sx, this.y + dip)
    ctx.quadraticCurveTo((sx + R) / 2, this.y + dip * 0.5, R, this.y)
    ctx.stroke()
    ctx.restore()
  }
}

/** the balancing pole: a long bar with weighted ends, see-sawing to counter
    his lean (drawn behind Pip, so its ends read as held out either side) */
class PoleProp implements SceneProp {
  x = 0
  y = 0
  tilt = 0
  private alpha = 1
  private dying = false

  constructor(private half: number) {}

  step(dt: number): boolean {
    if (this.dying) {
      this.alpha -= dt * 3.5
      if (this.alpha <= 0) return false
    }
    return true
  }

  die() {
    this.dying = true
  }

  draw(ctx: CanvasRenderingContext2D, pal: Palette) {
    ctx.save()
    ctx.globalAlpha = this.alpha
    ctx.translate(this.x, this.y)
    ctx.rotate(this.tilt)
    ctx.lineCap = "round"
    ctx.strokeStyle = pal.woodDark
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(-this.half, 0)
    ctx.lineTo(this.half, 0)
    ctx.stroke()
    ctx.strokeStyle = pal.woodMid
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(-this.half, 0)
    ctx.lineTo(this.half, 0)
    ctx.stroke()
    for (const s of [-1, 1]) {
      ctx.beginPath()
      ctx.arc(s * this.half, 0, 3.6, 0, 6.2832)
      ctx.fillStyle = pal.steel
      ctx.fill()
      ctx.lineWidth = 1.2
      ctx.strokeStyle = pal.steelEdge
      ctx.stroke()
    }
    ctx.restore()
  }
}

export class TightropeAct implements RingAct {
  id = "tightrope"
  weight = 1
  private actT = 0
  private rope: RopeProp | null = null
  private pole: PoleProp | null = null

  constructor(private e: PipEngine) {}

  start() {
    const e = this.e
    this.actT = 0
    const Sc = e.Sc
    this.rope = new RopeProp(e.px, e.py + Sc * 0.62, Sc * 2.2)
    this.pole = new PoleProp(Sc * 1.35)
    e.props.push(this.rope)
    e.props.push(this.pole)
  }

  update(dt: number) {
    const e = this.e
    this.actT += dt
    const Sc = e.Sc
    /* two-frequency teeter — an organic wobble he keeps recovering from */
    const wob =
      Math.sin(this.actT * 2.1) * 0.08 + Math.sin(this.actT * 5.3 + 1) * 0.05
    e.tiltExtra += wob
    if (this.rope) {
      this.rope.sagX = e.px
      this.rope.bounce = Math.sin(this.actT * 6) * 2 + Math.abs(wob) * 26
    }
    if (this.pole) {
      this.pole.x = e.px - wob * Sc * 0.25
      this.pole.y = e.py + Sc * 0.12
      this.pole.tilt = -wob * 2.4 /* the pole see-saws against his lean */
    }
    if (this.actT > 3.6) {
      this.cancel(true)
      e.act = ""
      e.gigPulse = 0.6 /* nailed the dismount */
      e.ringActNext = 2.5 + Math.random() * 3
    }
  }

  cancel(fast: boolean) {
    this.rope?.die()
    this.pole?.die()
    if (!fast) {
      this.rope = null
      this.pole = null
    }
  }
}
