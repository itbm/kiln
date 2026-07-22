import { elSpots, rectOfEl } from "../anchors"
import { armStroke } from "../draw/pip"
import type { PipEngine } from "../engine"
import { clamp, lerp } from "../math"
import type { PipAction, PipPose } from "../types"

const tileEl = () =>
  document.querySelector('[data-art-painting="true"]') as HTMLElement | null

/**
 * Per-canvas painting diary, keyed on the DOM node (mirrors build.ts's site
 * log): how long Pip has been at this canvas, which tool he's on and when
 * the next grand flourish is due. Living outside the action means popping
 * off for an overlay and darting back doesn't reset the clock.
 */
interface CanvasLog {
  t: number
  tool: number
  swapAt: number
  flourishAt: number
}
const canvasLogs = new WeakMap<Element, CanvasLog>()

const TOOLS = ["brush", "knife"] as const
const FLOURISH_AT = 22 /* seconds before the first grand sweeping stroke */
const SWAP_EVERY = () => 9 + Math.random() * 5

/** Painter Pip's paints — theme-independent daubs he loads onto the brush. */
const PAINTS = ["#E4572E", "#F3A712", "#2E9E8F", "#3D6DCC", "#B5477F", "#8FB339"]

/**
 * Painter Pip: while an image generates on the Images page its tile carries
 * data-art-painting, and — beret on, palette in hand — he perches on its top
 * edge and paints it into being. This is the Images-page twin of Foreman Pip
 * (build.ts): same "themed headwear + tools in hand, escalating show, back to
 * the ledge when it lands" shape, minus the airlift (a canvas is for painting,
 * not hauling about). He cycles a round brush (dabbing, coloured splats) and a
 * palette knife (broad smears), reloading colour off the palette between; past
 * the 22-second mark the job earns the occasional grand flourish. He's sent up
 * here by the engine's site check (engine.tick) and DartAction hands over on
 * landing; the moment the tile finishes he darts back to the composer ledge.
 */
export class PaintAction implements PipAction {
  id = "paint"
  private phase: "dab" | "load" | "smear" | "stand" | "flourish" | "scoot" =
    "dab"
  private phT = 0
  private phDur = 0.3
  private wx = 0.7 /* work position, fraction along the canvas top edge */
  private txf = 0.7 /* scoot destination fraction */
  private dabs = 3
  private reach = 0 /* 0 = brush up, 1 = brush pressed to the canvas */
  private dabK = 0 /* dab-impact squash envelope */
  private smearOff = 0 /* knife stroke offset, -1..1 across the edge */
  private scootPh = 0
  private loaded = false /* has this load bout already picked up its colour */
  private paint = PAINTS[0] /* colour currently on the brush */
  private log: CanvasLog = { t: 0, tool: 0, swapAt: 10, flourishAt: FLOURISH_AT }

  constructor(private e: PipEngine) {}

  begin() {
    const e = this.e
    e.mode = "paint"
    e.clearAct(true)
    const el = tileEl()
    const r = rectOfEl(el)
    if (el) this.logFor(el)
    this.wx = r ? clamp((e.px - r.left) / r.width, 0.18, 0.85) : 0.7
    e.faceT = this.wx > 0.55 ? -1 : 1 /* work toward the canvas middle */
    this.reach = 0
    this.dabK = 0
    this.paint = PAINTS[Math.floor(Math.random() * PAINTS.length)]
    this.bout()
  }

  private enter(phase: PaintAction["phase"], dur: number) {
    this.phase = phase
    this.phT = 0
    this.phDur = dur
  }

  /** point this.log at the canvas's diary, starting one for a new tile */
  private logFor(el: Element) {
    let log = canvasLogs.get(el)
    if (!log) {
      log = { t: 0, tool: 0, swapAt: SWAP_EVERY(), flourishAt: FLOURISH_AT }
      canvasLogs.set(el, log)
    }
    this.log = log
  }

  /* ---------- bout plumbing ---------- */

  private bout() {
    /* the palette moment — swap tools when one's due */
    if (this.log.t >= this.log.swapAt) {
      this.log.tool = (this.log.tool + 1) % TOOLS.length
      this.log.swapAt = this.log.t + SWAP_EVERY()
      this.e.flareV = 2.2 /* pleased little flare for the change of tack */
    }
    if (TOOLS[this.log.tool] === "brush") {
      this.dabs = 2 + Math.floor(Math.random() * 3)
      this.enter("dab", 0.3)
    } else {
      this.smearOff = -1
      this.enter("smear", 1.6 + Math.random() * 1)
    }
  }

  /** end-of-bout decision: flourish when it's due, else potter on */
  private nextUp(w: number) {
    if (this.log.t >= this.log.flourishAt) {
      this.log.flourishAt = this.log.t + 16 + Math.random() * 10
      this.enter("flourish", 0.95)
      return
    }
    const r = Math.random()
    if (r < 0.3) {
      this.loaded = false
      this.enter("load", 0.7 + Math.random() * 0.4)
    } else if (r < 0.5) this.enter("stand", 0.8 + Math.random() * 0.7)
    else this.scootOff(w)
  }

  private scootTo(f: number, w: number) {
    if (Math.abs(f - this.wx) * w < 55)
      f = this.wx > 0.5 ? this.wx - 55 / w : this.wx + 55 / w
    this.txf = clamp(f, 0.15, 0.88)
    this.scootPh = 0
    this.enter("scoot", 9) /* duration is a safety cap; ends on arrival */
  }

  private scootOff(w: number) {
    this.scootTo(0.18 + Math.random() * 0.67, w)
  }

  update(dt: number) {
    const e = this.e
    this.phT += dt
    this.dabK = Math.max(0, this.dabK - dt * 7)
    const el = tileEl()
    const r = rectOfEl(el)
    const comp = rectOfEl(document.querySelector('[data-pip-spot="composer"]'))
    const S = e.S0
    /* tile finished, covered by an overlay, or scrolled away → back to the
       ledge. A tall single-image tile can spill past the header, so ride the
       visible top edge rather than the (possibly off-screen) real one. */
    if (
      !el ||
      !r ||
      !comp ||
      r.bottom < 100 ||
      r.top > comp.top - S * 0.7 ||
      document.querySelector('[data-slot="drawer-content"], [data-slot="dialog-content"]')
    ) {
      this.done()
      return
    }
    this.logFor(el)
    this.log.t += dt

    /* ride the canvas's top edge (it drifts as tiles stream in) */
    const topEdge = clamp(r.top, 64, comp.top - S * 0.7)
    const footY = topEdge - S * 0.66 * 0.52
    const tx = clamp(r.left + this.wx * r.width, r.left + 16, r.right - 12)
    const kf = 1 - Math.pow(0.0008, dt)
    e.px += (tx - e.px) * kf
    e.py += (footY - e.py) * kf
    e.scale += (0.66 - e.scale) * (1 - Math.pow(0.01, dt))
    /* keep his flame trail alive (the engine only auto-spawns at rest) */
    if (Math.random() < dt * 1.5) e.drops.spawn(e.px, e.py - e.Sc * 1.05, false)
    const surfY = footY + S * 0.66 * 0.52 /* the canvas line, at his feet */
    const brushX = () => e.px + e.face * e.Sc * 0.72

    if (this.phase === "dab") {
      /* peck the brush down at the canvas, a coloured splat on each touch */
      const k = clamp(this.phT / this.phDur, 0, 1)
      this.reach = Math.sin(k * Math.PI)
      if (this.phT >= this.phDur) {
        this.dabK = 1
        e.flareV = 1.6
        for (let i = 0; i < 3; i++)
          e.drops.spawn(brushX(), surfY - 1, true, this.paint, 10)
        if (--this.dabs > 0) this.enter("dab", 0.24 + Math.random() * 0.12)
        else this.nextUp(r.width)
      }
    } else if (this.phase === "load") {
      /* dip the brush back on the palette and pick up a fresh colour
         (once, at the moment the tip touches the palette) */
      this.reach = 0
      if (!this.loaded && this.phT >= this.phDur * 0.5) {
        this.loaded = true
        this.paint = PAINTS[Math.floor(Math.random() * PAINTS.length)]
        e.flareV = 1.2
      }
      if (this.phT >= this.phDur) this.bout()
    } else if (this.phase === "smear") {
      /* long knife stroke sliding across the edge, colour dragged along */
      this.smearOff = clamp(-1 + (this.phT / this.phDur) * 2, -1, 1)
      this.reach = 0.7
      if (Math.random() < dt * 6)
        e.drops.spawn(brushX(), surfY - 1, true, this.paint, 8)
      if (this.phT >= this.phDur) {
        this.smearOff = 0
        this.nextUp(r.width)
      }
    } else if (this.phase === "stand") {
      /* step back, brush up, and squint at the work */
      this.reach = 0
      if (this.phT >= this.phDur) {
        if (Math.random() < 0.5) this.bout()
        else this.scootOff(r.width)
      }
    } else if (this.phase === "flourish") {
      /* a grand arcing stroke across the whole canvas, paint flying */
      const k = clamp(this.phT / this.phDur, 0, 1)
      this.smearOff = Math.sin(k * Math.PI) * (e.face > 0 ? 1 : -1)
      this.reach = 0.5 + Math.sin(k * Math.PI) * 0.5
      e.flareV = Math.max(e.flareV, 1.8)
      if (Math.random() < dt * 22)
        e.drops.spawn(
          brushX() + (Math.random() - 0.5) * e.Sc,
          surfY - 2,
          true,
          PAINTS[Math.floor(Math.random() * PAINTS.length)],
          14,
        )
      if (this.phT >= this.phDur) {
        this.smearOff = 0
        e.gigPulse = 0.7
        this.paint = PAINTS[Math.floor(Math.random() * PAINTS.length)]
        this.nextUp(r.width)
      }
    } else {
      /* scoot: carry brush and palette along to the next patch */
      this.reach = 0
      this.scootPh += dt * 7
      const step = (48 / Math.max(r.width, 1)) * dt
      const d = this.txf - this.wx
      e.faceT = d > 0 ? 1 : -1
      if (Math.abs(d) <= step || this.phT > this.phDur) {
        this.wx = this.txf
        e.faceT = this.wx > 0.55 ? -1 : 1
        this.bout()
      } else this.wx += Math.sign(d) * step
    }
  }

  private done() {
    const e = this.e
    e.gigPulse = 0.9 /* proud of his canvas */
    e.flareV = 2.4
    const home = elSpots(e.env).find((p) => p.home)
    e.startDart(home ?? e.pickNext())
  }

  /* ---------- the toolkit (front layer, drawn over him) ----------
     pose() flags BOTH hands (grip = tool hand, gripB = palette hand) so
     drawPip skips both arms; drawFront then draws palette + brush/knife in
     his transformed unit space, arms and hands landing over each. */

  /** forward-hand (brush/knife) position in unit space for the current move */
  private toolGrip(): { x: number; y: number } {
    if (this.phase === "load") return { x: -0.12, y: 0.34 } /* over the palette */
    if (TOOLS[this.log.tool] === "knife" || this.phase === "flourish")
      return { x: 0.34 + this.smearOff * 0.24, y: 0.24 + this.reach * 0.22 }
    /* brush: reaches down toward the canvas as it dabs */
    return { x: lerp(0.42, 0.6, this.reach), y: lerp(0.02, 0.42, this.reach) }
  }

  /** the palette hand, tucked low on his off side */
  private paletteGrip(): { x: number; y: number } {
    return { x: -0.4, y: 0.32 }
  }

  /** a closed hand wrapped over a handle (caps the arm drawn beneath) */
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

  /** a jaunty painter's beret, tipped over the flame crown (unit space; it
      inherits every lean and squash from the pose transform) */
  private drawBeret(c: CanvasRenderingContext2D) {
    c.save()
    c.lineJoin = "round"
    /* soft round cap, tilted a touch toward his face */
    c.beginPath()
    c.moveTo(-0.42, -0.66)
    c.bezierCurveTo(-0.56, -1.02, -0.28, -1.2, 0.1, -1.16)
    c.bezierCurveTo(0.44, -1.12, 0.5, -0.92, 0.42, -0.72)
    c.bezierCurveTo(0.28, -0.78, -0.22, -0.78, -0.42, -0.66)
    c.closePath()
    c.fillStyle = "#43608C"
    c.fill()
    c.lineWidth = 0.05
    c.strokeStyle = "#26374F"
    c.stroke()
    /* headband */
    c.beginPath()
    c.moveTo(-0.42, -0.66)
    c.quadraticCurveTo(0, -0.58, 0.42, -0.72)
    c.lineWidth = 0.07
    c.strokeStyle = "#2E4467"
    c.stroke()
    /* the little stalk */
    c.beginPath()
    c.arc(0.06, -1.2, 0.05, 0, 6.2832)
    c.fillStyle = "#2E4467"
    c.fill()
    /* highlight */
    c.beginPath()
    c.ellipse(-0.12, -1.0, 0.1, 0.05, -0.5, 0, 6.2832)
    c.fillStyle = "rgba(255,255,255,.28)"
    c.fill()
    c.restore()
  }

  /** the palette: an oval board with a thumb-hole and a row of paint daubs */
  private drawPalette(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
  ) {
    const e = this.e
    c.save()
    c.translate(x - e.face * 0.16, y + 0.12)
    c.rotate(-e.face * 0.2)
    c.beginPath()
    c.ellipse(0, 0, 0.42, 0.26, 0, 0, 6.2832)
    c.fillStyle = e.PAL.wood
    c.fill()
    c.lineWidth = 0.045
    c.strokeStyle = e.PAL.woodDark
    c.stroke()
    /* thumb hole toward his body */
    c.beginPath()
    c.ellipse(-0.22, 0.06, 0.07, 0.05, 0, 0, 6.2832)
    c.fillStyle = e.PAL.woodDark
    c.fill()
    /* daubs of paint */
    const blobs: [number, number][] = [
      [-0.02, -0.13],
      [0.18, -0.06],
      [0.24, 0.1],
      [0.05, 0.13],
      [-0.12, 0.08],
    ]
    for (let i = 0; i < blobs.length; i++) {
      c.beginPath()
      c.arc(blobs[i][0], blobs[i][1], 0.055, 0, 6.2832)
      c.fillStyle = PAINTS[i % PAINTS.length]
      c.fill()
    }
    c.restore()
  }

  /** the round brush: slim handle, ferrule, a loaded coloured tip */
  private drawBrush(c: CanvasRenderingContext2D, g: { x: number; y: number }) {
    const e = this.e
    c.save()
    c.translate(g.x, g.y)
    /* angle from held-up to pressed-down as he reaches for the canvas */
    c.rotate(lerp(0.5, 1.15, this.reach))
    c.lineCap = "round"
    /* handle */
    c.strokeStyle = e.PAL.woodDark
    c.lineWidth = 0.09
    c.beginPath()
    c.moveTo(0, -0.16)
    c.lineTo(0, 0.42)
    c.stroke()
    c.strokeStyle = e.PAL.woodMid
    c.lineWidth = 0.05
    c.beginPath()
    c.moveTo(0, -0.14)
    c.lineTo(0, 0.4)
    c.stroke()
    /* ferrule */
    c.strokeStyle = e.PAL.steel
    c.lineWidth = 0.1
    c.beginPath()
    c.moveTo(0, 0.42)
    c.lineTo(0, 0.54)
    c.stroke()
    /* bristle tip, wet with the loaded colour */
    c.beginPath()
    c.moveTo(-0.05, 0.54)
    c.quadraticCurveTo(0, 0.74, 0.05, 0.54)
    c.closePath()
    c.fillStyle = this.paint
    c.fill()
    c.restore()
  }

  /** the palette knife: short handle and a flat springy blade */
  private drawKnife(c: CanvasRenderingContext2D, g: { x: number; y: number }) {
    const e = this.e
    c.save()
    c.translate(g.x, g.y)
    c.rotate(lerp(0.6, 1.0, this.reach) + this.smearOff * 0.2)
    c.lineCap = "round"
    c.strokeStyle = e.PAL.woodDark
    c.lineWidth = 0.1
    c.beginPath()
    c.moveTo(0, -0.14)
    c.lineTo(0, 0.24)
    c.stroke()
    /* blade */
    c.beginPath()
    c.moveTo(-0.05, 0.24)
    c.lineTo(0.05, 0.24)
    c.lineTo(0.09, 0.62)
    c.quadraticCurveTo(0, 0.7, -0.09, 0.62)
    c.closePath()
    c.fillStyle = e.PAL.steel
    c.fill()
    c.lineWidth = 0.035
    c.strokeStyle = e.PAL.steelEdge
    c.stroke()
    /* a smear of colour along the blade */
    c.beginPath()
    c.moveTo(-0.05, 0.4)
    c.lineTo(0.05, 0.4)
    c.lineTo(0.06, 0.58)
    c.lineTo(-0.06, 0.58)
    c.closePath()
    c.fillStyle = this.paint
    c.globalAlpha = 0.85
    c.fill()
    c.restore()
  }

  drawFront(_t: number, pose: PipPose) {
    const e = this.e
    const c = e.g
    if (!c || e.mode !== "paint") return
    c.save()
    /* the same transform drawPip uses, so grips line up and held things
       lean/squash with his body */
    c.translate(pose.x, pose.y)
    c.rotate(pose.tilt)
    c.scale(pose.S * pose.sx * pose.face, pose.S * pose.sy)
    this.drawBeret(c)
    /* palette + back arm + hand */
    const gb = pose.gripB ?? this.paletteGrip()
    this.drawPalette(c, gb.x, gb.y)
    armStroke(c, -0.4, 0.2, gb.x, gb.y, -0.14, e.PAL.outline, e.PAL.limb)
    this.handOn(c, gb.x, gb.y)
    /* tool + front arm + hand */
    const g = pose.grip ?? this.toolGrip()
    if (TOOLS[this.log.tool] === "knife" || this.phase === "flourish")
      this.drawKnife(c, g)
    else this.drawBrush(c, g)
    armStroke(c, 0.4, 0.2, g.x, g.y, 0.12, e.PAL.outline, e.PAL.limb)
    this.handOn(c, g.x, g.y)
    c.restore()
  }

  pose(pose: PipPose, _t: number) {
    const e = this.e
    const U = e.Sc
    pose.grip = this.toolGrip()
    pose.gripB = this.paletteGrip()
    pose.gazeX = e.face * 0.4
    pose.gazeY = this.phase === "stand" ? -0.35 : 0.55
    if (this.phase === "dab") {
      pose.tilt += e.face * 0.05 * this.reach
      pose.y += this.reach * U * 0.02
      pose.effort = Math.max(pose.effort, this.reach * 0.35)
    } else if (this.phase === "smear" || this.phase === "flourish") {
      pose.tilt += e.face * this.smearOff * 0.06
      pose.x += e.face * this.smearOff * U * 0.05
      pose.effort = Math.max(
        pose.effort,
        (this.phase === "flourish" ? 0.5 : 0.3) + Math.abs(this.smearOff) * 0.25,
      )
    } else if (this.phase === "load") {
      pose.gazeX = -e.face * 0.3 /* eyes on the palette */
      pose.gazeY = 0.5
    } else if (this.phase === "stand") {
      pose.tilt -= e.face * 0.05 /* leaning back to appraise */
    } else if (this.phase === "scoot") {
      pose.gazeY = 0.15
      pose.tilt += e.face * 0.04
      pose.y -= Math.abs(Math.sin(this.scootPh)) * U * 0.05
    }
    pose.sy *= 1 - this.dabK * 0.09
    pose.sx *= 1 + this.dabK * 0.05
  }
}
