import { elSpots, rectOfEl } from "../anchors"
import { armStroke } from "../draw/pip"
import type { PipEngine } from "../engine"
import { clamp, lerp, n1 } from "../math"
import type { PipAction, PipPose } from "../types"

/** never sweep forever, however the compaction ends (or doesn't) */
const MAX_SWEEP = 30

/**
 * Tidying up: while a conversation is being compacted — the older messages
 * swept into a summary — Pip fetches a broom and works the composer ledge,
 * pushing little clouds of dust along it. When the summary lands he taps
 * the broom twice, admires the clean floor and darts home.
 *
 * Driven by the app, not the DOM: lib/compact.ts calls pip.tidy(true/false)
 * around the summarising request (see bus.ts). engine.tidy() routes those to
 * begin()/finish(); finish() is safe to call when he never got started, and
 * MAX_SWEEP stops him if the call never comes.
 */
export class SweepAction implements PipAction {
  id = "sweep"
  private swT = 0
  private ph = 0 /* stroke phase — the broom head swings with it */
  private dir = 1
  private wrapT = -1 /* >= 0 once he's finishing up */
  private tapK = 0 /* broom-tap impact envelope */
  private taps = 0
  private measureIn = 0
  private lineY = 0
  private minX = 0
  private maxX = 0

  constructor(private e: PipEngine) {}

  begin() {
    const e = this.e
    if (e.mode === "sweep") return
    e.leaveMode(true) /* whatever he was holding goes back first */
    e.clearAct(true)
    e.mode = "sweep"
    this.swT = 0
    this.ph = 0
    this.wrapT = -1
    this.tapK = 0
    this.taps = 0
    this.dir = Math.random() < 0.5 ? -1 : 1
    e.faceT = this.dir
    this.measure()
    e.flareV = 2
  }

  /** the compaction finished — broom taps, a look at his work, then off */
  finish() {
    if (this.e.mode !== "sweep" || this.wrapT >= 0) return
    this.wrapT = 0
    this.taps = 0
  }

  /** the ledge he sweeps: the composer line, else the ground under him */
  private measure() {
    const e = this.e
    const comp = rectOfEl(document.querySelector('[data-pip-spot="composer"]'))
    if (comp) {
      this.lineY = comp.top - e.S0 * 0.5
      this.minX = comp.left + 30
      this.maxX = comp.right - 30
    } else {
      this.lineY = e.py
      this.minX = clamp(e.px - 70, 24, e.W - 24)
      this.maxX = clamp(e.px + 70, 24, e.W - 24)
    }
    if (this.maxX - this.minX < 40) {
      this.minX = clamp(e.px - 20, 12, e.W - 12)
      this.maxX = clamp(e.px + 20, 12, e.W - 12)
    }
  }

  /** broom head offset along the ground, in unit space */
  private headX(): number {
    if (this.wrapT >= 0) return 0.62
    return 0.62 + Math.sin(this.ph) * 0.4
  }

  update(dt: number) {
    const e = this.e
    const Sc = e.Sc
    this.swT += dt
    this.tapK = Math.max(0, this.tapK - dt * 6)
    if (this.swT > MAX_SWEEP) this.finish()
    /* the ledge moves with the keyboard and the growing chat */
    this.measureIn -= dt
    if (this.measureIn <= 0) {
      this.measureIn = 0.4
      this.measure()
    }

    e.py += (this.lineY - e.py) * (1 - Math.pow(0.004, dt))
    e.scale += (0.78 - e.scale) * (1 - Math.pow(0.01, dt))

    if (this.wrapT < 0) {
      /* strokes, and a slow drift along the ledge between them */
      const prev = Math.sin(this.ph)
      this.ph += dt * 4.4
      const speed = Math.abs(Math.cos(this.ph))
      e.px += this.dir * 13 * dt
      if (e.px < this.minX) this.turn(1)
      else if (e.px > this.maxX) this.turn(-1)
      /* dust flies on the fast part of each forward push */
      const hx = e.px + e.face * this.headX() * Sc
      const hy = e.py + Sc * 0.72
      if (speed > 0.55 && Math.sin(this.ph) > prev) {
        if (Math.random() < dt * 22)
          e.drops.spawn(hx, hy, false, e.PAL.smoke, 26)
        if (Math.random() < dt * 4)
          e.drops.spawn(hx, hy, true, e.PAL.woodMid, 8)
      }
      if (Math.random() < dt * 1.2) e.drops.spawn(e.px, e.py - Sc * 1.05, false)
      return
    }

    /* wrapping up: tap the broom on the floor, twice, then admire it */
    this.wrapT += dt
    const beat = 0.34
    if (this.taps < Math.min(2, Math.floor(this.wrapT / beat) + 1)) {
      this.taps++
      this.tapK = 1
      e.flareV = 2.4
      const hx = e.px + e.face * 0.62 * Sc
      const hy = e.py + Sc * 0.72
      for (let i = 0; i < 4; i++) e.drops.spawn(hx, hy, false, e.PAL.smoke, 34)
      e.drops.spawn(hx, hy, true, e.PAL.woodMid, 10)
    }
    if (this.wrapT > beat * 2 + 0.5) this.done()
  }

  private turn(dir: number) {
    this.dir = dir
    this.e.faceT = dir
  }

  private done() {
    const e = this.e
    this.wrapT = -1
    e.gigPulse = 1 /* pleased with a tidy floor */
    e.flareV = 2.6
    const home = elSpots(e.env).find((p) => p.home)
    e.startDart(home ?? e.pickNext())
  }

  /** something else took the mode (drawer, teardown) — drop the broom */
  exit() {
    this.wrapT = -1
    this.taps = 0
    this.tapK = 0
  }

  /* ---------- the broom (front layer: in both hands, over his body) ------- */

  /** The broom in unit space: head on the ground at hx, handle aimed up at
      his chest and stopping just past the top hand — a stick through his
      face reads as an impalement, not a chore. */
  private stick(): { hx: number; hy: number; tx: number; ty: number } {
    const hx = this.headX()
    const hy = 0.72 - this.tapK * 0.06
    /* aim well clear of the eyes, then overshoot the upper grip a little */
    const cx = 0.44
    const cy = 0.1
    const dx = cx - hx
    const dy = cy - hy
    const len = Math.hypot(dx, dy) || 1
    return { hx, hy, tx: cx + (dx / len) * 0.1, ty: cy + (dy / len) * 0.1 }
  }

  private grips() {
    const s = this.stick()
    const at = (k: number) => ({
      x: lerp(s.hx, s.tx, k),
      y: lerp(s.hy, s.ty, k),
    })
    return { front: at(0.52), back: at(0.84) }
  }

  drawFront(_t: number, pose: PipPose) {
    const e = this.e
    const c = e.g
    if (!c || e.mode !== "sweep") return
    const s = this.stick()
    const g = pose.grip ?? this.grips().front
    const gb = pose.gripB ?? this.grips().back
    c.save()
    /* the same transform drawPip uses, so the broom sits in his hands */
    c.translate(pose.x, pose.y)
    c.rotate(pose.tilt)
    c.scale(pose.S * pose.sx * pose.face, pose.S * pose.sy)
    c.lineCap = "round"
    c.lineJoin = "round"
    /* handle */
    c.strokeStyle = e.PAL.woodDark
    c.lineWidth = 0.1
    c.beginPath()
    c.moveTo(s.hx, s.hy)
    c.lineTo(s.tx, s.ty)
    c.stroke()
    c.strokeStyle = e.PAL.wood
    c.lineWidth = 0.062
    c.beginPath()
    c.moveTo(s.hx, s.hy - 0.02)
    c.lineTo(s.tx, s.ty + 0.02)
    c.stroke()
    /* the head: binding plus a fan of bristles, square on the floor */
    c.save()
    c.translate(s.hx, s.hy)
    c.rotate(Math.atan2(s.ty - s.hy, s.tx - s.hx) + Math.PI / 2)
    c.beginPath()
    if (typeof c.roundRect === "function") c.roundRect(-0.13, -0.1, 0.26, 0.1, 0.04)
    else c.rect(-0.13, -0.1, 0.26, 0.1)
    c.fillStyle = e.PAL.steelEdge
    c.fill()
    c.strokeStyle = e.PAL.woodDark
    c.lineWidth = 0.028
    c.stroke()
    c.strokeStyle = e.PAL.woodMid
    c.lineWidth = 0.036
    for (let i = -3; i <= 3; i++) {
      c.beginPath()
      c.moveTo(i * 0.038, 0)
      c.lineTo(i * 0.056, 0.2)
      c.stroke()
    }
    c.restore()
    /* both arms over the handle, hands closed around it */
    armStroke(c, -0.4, 0.2, gb.x, gb.y, -0.1, e.PAL.outline, e.PAL.limb)
    armStroke(c, 0.4, 0.2, g.x, g.y, 0.12, e.PAL.outline, e.PAL.limb)
    for (const h of [gb, g]) {
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

  pose(pose: PipPose, t: number) {
    const e = this.e
    const U = e.Sc
    const gr = this.grips()
    pose.grip = gr.front
    pose.gripB = gr.back
    pose.gazeX = e.face * 0.5
    pose.gazeY = 0.65
    /* lean into each push, and let the shoulders roll with the stroke */
    const s = this.wrapT < 0 ? Math.sin(this.ph) : 0
    pose.tilt += e.face * (0.05 + s * 0.05)
    pose.x += e.face * s * U * 0.03
    pose.y += Math.abs(Math.cos(this.ph)) * U * 0.012 + n1(t * 2.6) * U * 0.004
    pose.effort = Math.max(pose.effort, 0.25 + Math.abs(Math.cos(this.ph)) * 0.25)
    pose.sy *= 1 - this.tapK * 0.07
    pose.sx *= 1 + this.tapK * 0.05
  }
}
