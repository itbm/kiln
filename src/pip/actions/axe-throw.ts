import type { PipEngine } from "../engine"
import { clamp, easeOutBack, lerp } from "../math"
import type { Palette } from "../palette"
import type { RingAct, SceneProp } from "../types"

/*
 * Pip's signature ring act: a little target pops up beside the home ring,
 * he winds up and hurls a throwing axe into it. To add another act (say,
 * throwing axes at a Christmas tree), copy this file's shape — props
 * implementing SceneProp plus a RingAct — and register it in
 * src/pip/actions/index.ts.
 */

class TargetProp implements SceneProp {
  x: number
  y: number
  t = 0
  hitT = -1
  alpha = 1
  dying = false

  constructor(x: number, y: number) {
    this.x = x
    this.y = y
  }

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
    const pop = easeOutBack(clamp(this.t / 0.2, 0, 1))
    const wob =
      this.hitT >= 0
        ? Math.sin((t - this.hitT) * 26) * 0.14 * Math.exp(-(t - this.hitT) * 3.2)
        : 0
    ctx.save()
    ctx.globalAlpha = this.alpha
    ctx.translate(this.x, this.y)
    /* little legs */
    ctx.strokeStyle = pal.woodDark
    ctx.lineWidth = 3
    ctx.lineCap = "round"
    ctx.beginPath()
    ctx.moveTo(-7, 10)
    ctx.lineTo(-11, 22)
    ctx.moveTo(7, 10)
    ctx.lineTo(11, 22)
    ctx.stroke()
    ctx.rotate(wob)
    ctx.scale(pop, pop)
    ctx.beginPath()
    ctx.arc(0, 0, 16, 0, 6.2832)
    ctx.fillStyle = pal.wood
    ctx.fill()
    ctx.lineWidth = 2.5
    ctx.strokeStyle = pal.woodDark
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(0, 0, 10, 0, 6.2832)
    ctx.fillStyle = pal.woodMid
    ctx.fill()
    ctx.lineWidth = 1.6
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(0, 0, 4.5, 0, 6.2832)
    ctx.fillStyle = pal.bodyEdge
    ctx.fill()
    ctx.restore()
  }
}

class AxeProp implements SceneProp {
  x: number
  y: number
  sx: number
  sy: number
  rot: number
  rotV: number
  t = 0
  alpha = 1
  stuck = false
  dying = false

  constructor(x: number, y: number, face: number) {
    this.x = x
    this.y = y
    this.sx = x
    this.sy = y
    this.rot = -1.1 * face
    this.rotV = face * 17
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
    ctx.save()
    ctx.globalAlpha = this.alpha
    ctx.translate(this.x, this.y)
    ctx.rotate(this.rot)
    /* handle */
    ctx.lineCap = "round"
    ctx.strokeStyle = pal.woodDark
    ctx.lineWidth = 4.6
    ctx.beginPath()
    ctx.moveTo(0, 12)
    ctx.lineTo(0, -13)
    ctx.stroke()
    ctx.strokeStyle = pal.wood
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(0, 11)
    ctx.lineTo(0, -12)
    ctx.stroke()
    /* head */
    ctx.beginPath()
    ctx.moveTo(-1, -14)
    ctx.lineTo(11, -19)
    ctx.quadraticCurveTo(15, -13, 11, -6)
    ctx.lineTo(-1, -8)
    ctx.closePath()
    ctx.fillStyle = pal.steel
    ctx.fill()
    ctx.lineWidth = 1.6
    ctx.strokeStyle = pal.steelEdge
    ctx.stroke()
    ctx.strokeStyle = "#ffffff"
    ctx.globalAlpha = this.alpha * 0.8
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.moveTo(11.5, -17.5)
    ctx.quadraticCurveTo(14.4, -12.8, 11.5, -7.5)
    ctx.stroke()
    ctx.restore()
  }
}

export class AxeThrowAct implements RingAct {
  id = "axe"
  weight = 1
  private actT = 0
  private targ: TargetProp | null = null
  private axe: AxeProp | null = null

  constructor(private e: PipEngine) {}

  start() {
    const e = this.e
    this.actT = 0
    this.targ = null
    this.axe = null
    e.faceT = Math.random() < 0.5 ? -1 : 1
    const Sc = e.Sc
    let tx = e.px + e.faceT * Sc * 2.9
    if (tx < 34 || tx > e.W - 34) {
      e.faceT = -e.faceT
      tx = e.px + e.faceT * Sc * 2.9
    }
    this.targ = new TargetProp(clamp(tx, 34, e.W - 34), e.py + Sc * 0.1)
    e.props.push(this.targ)
  }

  update(dt: number, t: number) {
    const e = this.e
    const prevT = this.actT
    this.actT += dt
    e.windup =
      this.actT < 0.38
        ? Math.sin(clamp(this.actT / 0.38, 0, 1) * Math.PI)
        : Math.max(0, e.windup - dt * 6)
    e.tiltExtra -= e.faceT * 0.13 * e.windup
    if (prevT < 0.38 && this.actT >= 0.38 && this.targ) {
      const Sc = e.Sc
      this.axe = new AxeProp(e.px + e.face * Sc * 0.4, e.py - Sc * 0.6, e.face)
      e.props.push(this.axe)
      e.flareV = 2.6
    }
    if (this.axe && !this.axe.stuck && this.targ) {
      this.axe.t += dt
      const ak = clamp(this.axe.t / 0.34, 0, 1)
      this.axe.x = lerp(this.axe.sx, this.targ.x - e.face * 7, ak)
      this.axe.y =
        lerp(this.axe.sy, this.targ.y - 3, ak) - Math.sin(ak * Math.PI) * 13
      this.axe.rot += this.axe.rotV * dt
      if (ak >= 1) {
        this.axe.stuck = true
        this.axe.rot = e.face > 0 ? 0.5 : -0.5
        this.targ.hitT = t
        e.gigPulse = 0.9
        for (let i = 0; i < 5; i++)
          e.drops.spawn(this.targ.x, this.targ.y, true, e.PAL.wood)
      }
    }
    if (this.actT > 2.15) {
      this.cancel(true)
      e.act = ""
      e.ringActNext = 2.5 + Math.random() * 3
    }
  }

  cancel(fast: boolean) {
    this.targ?.die()
    this.axe?.die()
    if (!fast) {
      this.targ = null
      this.axe = null
    }
    this.e.windup = 0
  }
}
