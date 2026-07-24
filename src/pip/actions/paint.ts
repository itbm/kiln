import { elSpots, rectOfEl } from "../anchors"
import { armStroke } from "../draw/pip"
import type { PipEngine } from "../engine"
import { clamp, easeIO, lerp, n1 } from "../math"
import type { PipAction, PipPose } from "../types"

const easelEl = () =>
  document.querySelector('[data-art-painting="true"]') as HTMLElement | null

/**
 * Per-canvas diary, keyed on the DOM node (same trick as the building
 * site): how long he has been painting this one, which colour is on the
 * brush and when the signature is due. Popping off for an overlay and
 * coming back doesn't restart the clock.
 */
interface EaselLog {
  t: number
  col: number
  signAt: number
}
const easelLogs = new WeakMap<Element, EaselLog>()

/** his paint box — dabs on the palette and colour on the brush */
const PAINTS = ["#E4572E", "#F5A623", "#3FA7D6", "#59C36A", "#8E5BD6", "#F2E14C"]
const SIGN_AT = 22 /* seconds of painting before he signs the thing */

/**
 * Painter Pip: while an image generates on the Images page he stands on the
 * top edge of the "Painting…" tile — beret on, palette in his off hand —
 * and works the canvas. He dips, dabs, lays a long stroke, and now and then
 * leans back with the brush at arm's length to measure the composition like
 * every painter in every cartoon. The moment the picture lands (the tile's
 * data-art-painting flag clears) he darts back to the composer ledge.
 *
 * This mirrors the builder (actions/build.ts): the engine's site check sends
 * him up, DartAction hands over on landing, and the same overlay/out-of-band
 * rules send him home. Past 22 seconds the job has earned a signature, so he
 * scoots to the corner and flourishes one onto the canvas — it fades on its
 * own, and exit() drops it if anything takes the mode away first.
 */
export class PaintAction implements PipAction {
  id = "paint"
  private phase: "dip" | "dab" | "stroke" | "squint" | "scoot" | "sign" =
    "dip"
  private phT = 0
  private phDur = 0.3
  private wx = 0.7 /* work position, fraction along the tile's top edge */
  private txf = 0.7
  private dabs = 3
  private hitK = 0 /* brush-contact squash envelope */
  private scootPh = 0
  private strokePh = 0
  private thenSign = false
  private dipped = false
  private brushAng = 0
  private log: EaselLog = { t: 0, col: 0, signAt: SIGN_AT }
  /* the signature: drawn on the canvas below him, then left to dry off */
  private sigK = -1 /* reveal 0..1; -1 = nothing on the canvas */
  private sigA = 1 /* alpha, once it starts drying */
  private sigDrying = false
  private sigX = 0
  private sigY = 0
  private sigW = 40
  private sigCol = PAINTS[0]

  constructor(private e: PipEngine) {}

  begin() {
    const e = this.e
    e.mode = "paint"
    e.clearAct(true)
    const el = easelEl()
    const r = rectOfEl(el)
    if (el) this.logFor(el)
    this.wx = r ? clamp((e.px - r.left) / r.width, 0.18, 0.85) : 0.7
    e.faceT = this.wx > 0.55 ? -1 : 1 /* work toward the middle of the canvas */
    this.hitK = 0
    this.thenSign = false
    this.clearSignature()
    this.enter("dip", 0.4)
  }

  private enter(phase: PaintAction["phase"], dur: number) {
    this.phase = phase
    this.phT = 0
    this.phDur = dur
    if (phase === "dip") this.dipped = false
    if (phase === "stroke") this.strokePh = 0
  }

  private clearSignature() {
    this.sigK = -1
    this.sigA = 1
    this.sigDrying = false
  }

  private logFor(el: Element) {
    let log = easelLogs.get(el)
    if (!log) {
      log = { t: 0, col: Math.floor(Math.random() * PAINTS.length), signAt: SIGN_AT }
      easelLogs.set(el, log)
    }
    this.log = log
  }

  private colour(): string {
    return PAINTS[this.log.col % PAINTS.length]
  }

  /** end-of-bout decision: sign when it's due, else potter on */
  private nextUp(w: number) {
    if (this.log.t >= this.log.signAt) {
      this.thenSign = true
      this.scootTo(this.e.face > 0 ? 0.78 : 0.22, w)
      return
    }
    const r = Math.random()
    if (r < 0.3) this.enter("squint", 0.9 + Math.random() * 0.6)
    else if (r < 0.5) this.scootOff(w)
    else if (r < 0.75) this.enter("stroke", 1.6 + Math.random() * 0.9)
    else this.enter("dip", 0.4)
  }

  private scootTo(f: number, w: number) {
    if (Math.abs(f - this.wx) * w < 50)
      f = this.wx > 0.5 ? this.wx - 50 / w : this.wx + 50 / w
    this.txf = clamp(f, 0.15, 0.85)
    this.scootPh = 0
    this.enter("scoot", 9) /* the duration is a safety cap; ends on arrival */
  }

  private scootOff(w: number) {
    this.scootTo(0.18 + Math.random() * 0.64, w)
  }

  update(dt: number) {
    const e = this.e
    this.phT += dt
    this.hitK = Math.max(0, this.hitK - dt * 7)
    if (this.sigDrying) {
      this.sigA -= dt * 0.45
      if (this.sigA <= 0) this.clearSignature()
    }
    const el = easelEl()
    const r = rectOfEl(el)
    const comp = rectOfEl(document.querySelector('[data-pip-spot="composer"]'))
    const S = e.S0
    /* picture landed, covered by an overlay, or scrolled out of reach →
       straight back down to the ledge */
    if (
      !el ||
      !r ||
      !comp ||
      r.top < 54 ||
      r.top > comp.top - S * 0.9 ||
      document.querySelector(
        '[data-slot="drawer-content"], [data-slot="dialog-content"]',
      )
    ) {
      this.done()
      return
    }
    this.logFor(el)
    this.log.t += dt

    /* ride the top edge of the canvas (it drifts as the page grows) */
    const footY = r.top - S * 0.64 * 0.52
    const tx = clamp(r.left + this.wx * r.width, r.left + 16, r.right - 12)
    const kf = 1 - Math.pow(0.0008, dt)
    e.px += (tx - e.px) * kf
    e.py += (footY - e.py) * kf
    e.scale += (0.64 - e.scale) * (1 - Math.pow(0.01, dt))
    if (Math.random() < dt * 1.5) e.drops.spawn(e.px, e.py - e.Sc * 1.05, false)

    if (this.phase === "dip") {
      /* brush back to the palette, a fresh colour loaded on the way out */
      if (!this.dipped && this.phT >= this.phDur * 0.55) {
        this.dipped = true
        this.log.col = (this.log.col + 1 + Math.floor(Math.random() * 3)) % PAINTS.length
        e.drops.spawn(e.px - e.face * e.Sc * 0.4, e.py + e.Sc * 0.3, false, this.colour(), 8)
      }
      if (this.phT >= this.phDur) {
        this.dabs = 2 + Math.floor(Math.random() * 3)
        this.enter("dab", 0.3)
      }
    } else if (this.phase === "dab") {
      if (this.phT >= this.phDur) {
        /* tap — a fleck of colour flicks off the bristles */
        this.hitK = 1
        e.flareV = Math.max(e.flareV, 1.6)
        const hx = e.px + e.face * e.Sc * 0.66
        e.drops.spawn(hx, r.top - 1, true, this.colour(), 10)
        if (Math.random() < 0.4) e.drops.spawn(hx, r.top - 1, true, this.colour(), 10)
        if (--this.dabs > 0) this.enter("dab", 0.26 + Math.random() * 0.18)
        else this.nextUp(r.width)
      }
    } else if (this.phase === "stroke") {
      /* one long lateral sweep, laying colour as it goes */
      this.strokePh += dt * 3.4
      if (Math.random() < dt * 7)
        e.drops.spawn(
          e.px + e.face * e.Sc * (0.5 + Math.sin(this.strokePh) * 0.28),
          r.top - 1,
          true,
          this.colour(),
          8,
        )
      if (this.phT >= this.phDur) this.nextUp(r.width)
    } else if (this.phase === "squint") {
      if (this.phT >= this.phDur) {
        if (Math.random() < 0.55) this.enter("dip", 0.4)
        else this.scootOff(r.width)
      }
    } else if (this.phase === "scoot") {
      this.scootPh += dt * 7
      const step = (48 / Math.max(r.width, 1)) * dt
      const d = this.txf - this.wx
      e.faceT = d > 0 ? 1 : -1
      if (Math.abs(d) <= step || this.phT > this.phDur) {
        this.wx = this.txf
        e.faceT = this.wx > 0.55 ? -1 : 1
        if (this.thenSign) {
          this.thenSign = false
          this.sigCol = this.colour()
          this.sigW = clamp(r.width * 0.16, 30, 58)
          this.sigX = clamp(
            e.px - (e.face > 0 ? 0 : this.sigW),
            r.left + 8,
            r.right - this.sigW - 8,
          )
          this.sigY = r.top + Math.min(26, r.height * 0.12)
          this.clearSignature()
          this.sigK = 0
          this.enter("sign", 1.5)
        } else this.enter("dip", 0.4)
      } else this.wx += Math.sign(d) * step
    } else {
      /* the signature: a flourish across the corner, then he stands back */
      const k = clamp(this.phT / (this.phDur * 0.75), 0, 1)
      this.sigK = k
      if (Math.random() < dt * 10 && k < 1)
        e.drops.spawn(this.sigX + this.sigW * k, this.sigY, false, this.sigCol, 10)
      if (this.phT >= this.phDur) {
        e.gigPulse = 1.1
        e.flareV = 2.8
        this.sigDrying = true
        this.log.signAt = this.log.t + 26 + Math.random() * 14
        this.enter("squint", 1) /* admire it */
      }
    }
    /* the brush swings to whatever the phase asks of it */
    this.brushAng += (this.targetAng() - this.brushAng) * (1 - Math.pow(0.004, dt))
  }

  private done() {
    const e = this.e
    this.clearSignature()
    e.windup = 0
    e.gigPulse = 0.9 /* pleased with it */
    e.flareV = 2.4
    const home = elSpots(e.env).find((p) => p.home)
    e.startDart(home ?? e.pickNext())
  }

  /** another action is taking the mode over — the flourish goes with him */
  exit() {
    this.clearSignature()
    this.thenSign = false
  }

  /* ---------- the kit ---------- */

  /** brush angle for the phase: 0 = tip down on the canvas, PI = held up */
  private targetAng(): number {
    if (this.phase === "squint") return Math.PI
    if (this.phase === "dip") return -0.6
    return 0.15
  }

  /** forward-hand (brush) position in unit space for the current phase */
  private brushGrip(): { x: number; y: number } {
    if (this.phase === "dab") {
      const k = clamp(this.phT / this.phDur, 0, 1) ** 2
      return { x: lerp(0.5, 0.66, k), y: lerp(-0.1, 0.42, k) }
    }
    if (this.phase === "stroke") {
      const s = Math.sin(this.strokePh)
      return { x: 0.52 + s * 0.3, y: 0.38 + Math.abs(s) * 0.04 }
    }
    if (this.phase === "sign") {
      const k = clamp(this.sigK, 0, 1)
      return { x: lerp(0.34, 0.78, k), y: 0.44 }
    }
    if (this.phase === "squint") return { x: 0.42, y: -0.5 }
    if (this.phase === "dip") return { x: -0.24, y: 0.24 } /* on the palette */
    return { x: 0.5, y: 0.16 }
  }

  /** the palette hand (his off hand) — always tucked at his side */
  private paletteGrip(): { x: number; y: number } {
    return { x: -0.44, y: 0.28 }
  }

  private handOn(c: CanvasRenderingContext2D, x: number, y: number) {
    const e = this.e
    c.beginPath()
    c.arc(x, y, 0.1, 0, 6.2832)
    c.fillStyle = e.PAL.limb
    c.fill()
    c.lineWidth = 0.032
    c.strokeStyle = e.PAL.outline
    c.stroke()
  }

  /** the beret: a soft disc worn at an angle, with the little stalk on top */
  private drawBeret(c: CanvasRenderingContext2D) {
    c.save()
    c.translate(-0.06, -0.78)
    c.rotate(-0.24)
    c.lineJoin = "round"
    c.beginPath()
    c.moveTo(-0.46, 0.06)
    c.bezierCurveTo(-0.56, -0.3, -0.24, -0.46, 0.06, -0.42)
    c.bezierCurveTo(0.42, -0.38, 0.56, -0.16, 0.44, 0.04)
    c.bezierCurveTo(0.2, 0.16, -0.22, 0.17, -0.46, 0.06)
    c.closePath()
    c.fillStyle = "#46456B"
    c.fill()
    c.lineWidth = 0.05
    c.strokeStyle = "#28284A"
    c.stroke()
    /* the headband edge */
    c.beginPath()
    c.ellipse(-0.02, 0.07, 0.4, 0.08, 0.04, 0, 6.2832)
    c.fillStyle = "#37365A"
    c.fill()
    c.lineWidth = 0.04
    c.stroke()
    /* stalk */
    c.beginPath()
    c.arc(0.04, -0.44, 0.055, 0, 6.2832)
    c.fillStyle = "#37365A"
    c.fill()
    c.stroke()
    /* a little sheen */
    c.beginPath()
    c.ellipse(-0.16, -0.24, 0.13, 0.06, -0.4, 0, 6.2832)
    c.fillStyle = "rgba(255,255,255,.22)"
    c.fill()
    c.restore()
  }

  /** the palette: wooden oval, thumb hole, five dabs of colour */
  private drawPalette(c: CanvasRenderingContext2D) {
    const e = this.e
    const g = this.paletteGrip()
    c.save()
    c.translate(g.x - 0.12, g.y + 0.04)
    c.rotate(0.22)
    c.beginPath()
    c.ellipse(0, 0, 0.42, 0.28, 0, 0, 6.2832)
    c.fillStyle = e.PAL.wood
    c.fill()
    c.lineWidth = 0.045
    c.strokeStyle = e.PAL.woodDark
    c.stroke()
    /* thumb hole where his hand takes it */
    c.beginPath()
    c.ellipse(0.16, 0.02, 0.09, 0.07, 0, 0, 6.2832)
    c.fillStyle = e.PAL.woodDark
    c.fill()
    /* the paints */
    for (let i = 0; i < 5; i++) {
      const a = -2.5 + i * 0.72
      c.beginPath()
      c.ellipse(Math.cos(a) * 0.23 - 0.05, Math.sin(a) * 0.15, 0.065, 0.05, 0, 0, 6.2832)
      c.fillStyle = PAINTS[(this.log.col + i) % PAINTS.length]
      c.fill()
    }
    c.restore()
  }

  /** the brush, pivoting on his hand; tip carries the current colour */
  private drawBrush(c: CanvasRenderingContext2D, g: { x: number; y: number }) {
    const e = this.e
    c.save()
    c.translate(g.x, g.y)
    c.rotate(this.brushAng)
    c.lineCap = "round"
    c.lineJoin = "round"
    /* handle */
    c.strokeStyle = e.PAL.woodDark
    c.lineWidth = 0.1
    c.beginPath()
    c.moveTo(0, 0.04)
    c.lineTo(0, -0.5)
    c.stroke()
    c.strokeStyle = e.PAL.wood
    c.lineWidth = 0.062
    c.beginPath()
    c.moveTo(0, 0.02)
    c.lineTo(0, -0.47)
    c.stroke()
    /* ferrule */
    c.beginPath()
    if (typeof c.roundRect === "function") c.roundRect(-0.045, 0.02, 0.09, 0.14, 0.03)
    else c.rect(-0.045, 0.02, 0.09, 0.14)
    c.fillStyle = e.PAL.steel
    c.fill()
    c.lineWidth = 0.03
    c.strokeStyle = e.PAL.steelEdge
    c.stroke()
    /* bristles, loaded with paint */
    c.beginPath()
    c.moveTo(-0.05, 0.15)
    c.lineTo(0.05, 0.15)
    c.lineTo(0.012, 0.33)
    c.lineTo(-0.012, 0.33)
    c.closePath()
    c.fillStyle = this.colour()
    c.fill()
    c.lineWidth = 0.026
    c.strokeStyle = e.PAL.outline
    c.stroke()
    c.restore()
  }

  /** back layer: the signature he leaves on the canvas, fading as it dries */
  draw() {
    const e = this.e
    const c = e.g
    if (!c || this.sigK < 0) return
    c.save()
    c.globalAlpha = clamp(this.sigA, 0, 1) * 0.95
    c.translate(this.sigX, this.sigY)
    c.strokeStyle = this.sigCol
    c.lineWidth = 2.2
    c.lineCap = "round"
    c.lineJoin = "round"
    c.beginPath()
    const N = 40
    const upto = Math.max(1, Math.round(N * clamp(this.sigK, 0, 1)))
    for (let i = 0; i <= upto; i++) {
      const u = i / N
      const x = u * this.sigW
      const y = -Math.sin(u * 7.6) * 7 * (0.35 + 0.65 * (1 - u)) - u * 2
      if (i === 0) c.moveTo(x, y)
      else c.lineTo(x, y)
    }
    c.stroke()
    c.restore()
  }

  drawFront(_t: number, pose: PipPose) {
    const e = this.e
    const c = e.g
    if (!c || e.mode !== "paint") return
    c.save()
    /* the same transform drawPip uses, so hands and kit line up */
    c.translate(pose.x, pose.y)
    c.rotate(pose.tilt)
    c.scale(pose.S * pose.sx * pose.face, pose.S * pose.sy)
    this.drawBeret(c)
    const g = pose.grip ?? this.brushGrip()
    const gb = pose.gripB ?? this.paletteGrip()
    /* palette first, then the arm that holds it, then the hand on top */
    this.drawPalette(c)
    armStroke(c, -0.4, 0.2, gb.x, gb.y, -0.14, e.PAL.outline, e.PAL.limb)
    this.handOn(c, gb.x, gb.y)
    /* brush, then the painting arm over its handle */
    this.drawBrush(c, g)
    armStroke(c, 0.4, 0.2, g.x, g.y, 0.12, e.PAL.outline, e.PAL.limb)
    this.handOn(c, g.x, g.y)
    c.restore()
  }

  pose(pose: PipPose, t: number) {
    const e = this.e
    const U = e.Sc
    pose.grip = this.brushGrip()
    pose.gripB = this.paletteGrip()
    pose.gazeX = e.face * 0.45
    pose.gazeY = 0.5
    if (this.phase === "dab") {
      pose.tilt += e.face * 0.06
      pose.effort = Math.max(pose.effort, 0.2)
    } else if (this.phase === "stroke") {
      /* lean along the sweep */
      const s = Math.sin(this.strokePh)
      pose.tilt += e.face * s * 0.05
      pose.x += e.face * s * U * 0.05
      pose.effort = Math.max(pose.effort, 0.3)
    } else if (this.phase === "squint") {
      /* back on the heels, one long look down the brush */
      pose.tilt -= e.face * 0.09
      pose.lid *= 0.4
      pose.gazeX = e.face * 0.55
      pose.gazeY = 0.3
      pose.x -= e.face * U * 0.06
    } else if (this.phase === "scoot") {
      pose.gazeY = 0.15
      pose.tilt += e.face * 0.04
      pose.y -= Math.abs(Math.sin(this.scootPh)) * U * 0.05
    } else if (this.phase === "sign") {
      pose.tilt += e.face * 0.08
      pose.gazeY = 0.7
      pose.y += n1(t * 3) * U * 0.008
    } else if (this.phase === "dip") {
      /* reaching across to the palette */
      const k = easeIO(clamp(this.phT / this.phDur, 0, 1))
      pose.tilt -= e.face * 0.05 * Math.sin(k * Math.PI)
      pose.gazeX = -e.face * 0.4
    }
    pose.sy *= 1 - this.hitK * 0.08
    pose.sx *= 1 + this.hitK * 0.05
  }
}
