import { resolveSpot } from "../anchors"
import { armStroke } from "../draw/pip"
import type { PipEngine } from "../engine"
import type { PipAction, PipPose } from "../types"

/** longest Pip will keep sweeping if the "stop" signal never arrives */
const MAX_SWEEP = 30

type Pt = { x: number; y: number }
interface BroomGeom {
  top: Pt
  head: Pt
  gUp: Pt
  gLo: Pt
}
const lerpPt = (a: Pt, b: Pt, k: number): Pt => ({
  x: a.x + (b.x - a.x) * k,
  y: a.y + (b.y - a.y) * k,
})

/**
 * Janitor Pip: while a conversation is being compacted (see lib/compact.ts)
 * he reads "summarising" as "tidying up", fetches a broom and sweeps in place
 * — bristles dragging across the ledge, a little dust cloud kicking up on each
 * push. He keeps at it while engine.sweepReq holds; when the compaction lands
 * (or a safety cap trips) he gives the pile a satisfied last puff and settles
 * back down. Entered directly from the bus (engine.sweep), not via a dart, so
 * begin() hands the old mode back itself.
 */
export class SweepAction implements PipAction {
  id = "sweep"
  private t = 0
  private sweepPh = 0
  private finishing = false
  private finT = 0

  constructor(private e: PipEngine) {}

  begin() {
    const e = this.e
    e.leaveMode(true) /* release whatever mode he was in (build/paint/patrol) */
    e.clearAct(true)
    e.mode = "sweep"
    this.t = 0
    this.sweepPh = 0
    this.finishing = false
    this.finT = 0
    /* face toward the middle of the screen so he sweeps inward, not off-edge */
    e.faceT = e.px > e.W / 2 ? -1 : 1
  }

  /** broom geometry in unit space for the current stroke (sx = sin sweepPh):
      handle up-and-back over his shoulder, bristles down-forward on the floor,
      the head sliding as he pushes and pulls */
  private geom(sx: number): BroomGeom {
    const top: Pt = { x: -0.25, y: -0.55 }
    const head: Pt = { x: 0.5 + sx * 0.24, y: 0.62 }
    return { top, head, gUp: lerpPt(top, head, 0.42), gLo: lerpPt(top, head, 0.66) }
  }

  update(dt: number) {
    const e = this.e
    this.t += dt
    if (!this.finishing) this.sweepPh += dt * 5.5
    const sx = Math.sin(this.sweepPh)
    const Sc = e.Sc

    /* hold his perch against layout drift (he sweeps where he stands) */
    const p = resolveSpot(e.spot, e.env)
    if (p) {
      const kf = 1 - Math.pow(0.004, dt)
      e.px += (p.x - e.px) * kf
      e.py += (p.y - e.py) * kf
      e.scale += ((p.s ?? 1) - e.scale) * kf
    }

    /* dust off the fast part of each stroke; keep his flame trail alive */
    const hx = e.px + e.face * (0.5 + sx * 0.24) * Sc
    const hy = e.py + 0.62 * Sc
    if (!this.finishing && Math.abs(Math.cos(this.sweepPh)) > 0.6 && Math.random() < dt * 10)
      e.drops.spawn(hx, hy, false, e.PAL.smoke, 26)
    if (Math.random() < dt * 1.4) e.drops.spawn(e.px, e.py - Sc * 1.05, false)

    if (this.finishing) {
      this.finT += dt
      if (this.finT > 0.6) this.done()
      return
    }
    /* wrap up when the compaction clears (or the safety cap trips) */
    if (!e.sweepReq || this.t > MAX_SWEEP) {
      this.finishing = true
      this.finT = 0
      e.flareV = 2
      e.gigPulse = 0.7 /* pleased with the tidy */
      for (let i = 0; i < 3; i++) e.drops.spawn(hx, hy, false, e.PAL.smoke, 32)
    }
  }

  private done() {
    const e = this.e
    e.sweepReq = false
    if (resolveSpot(e.spot, e.env)) e.enterRest()
    else e.startDart(e.pickNext())
  }

  /** the mode is being stolen (drawer hit, teardown) — nothing held on the
      DOM, so just clear the tidy request so a later reply doesn't resume it */
  exit() {
    this.e.sweepReq = false
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

  /** the broom: wooden shaft with a fan of straw bristles at the head */
  private drawBroom(c: CanvasRenderingContext2D, g: BroomGeom) {
    const e = this.e
    c.save()
    c.lineCap = "round"
    c.lineJoin = "round"
    /* shaft */
    c.strokeStyle = e.PAL.woodDark
    c.lineWidth = 0.09
    c.beginPath()
    c.moveTo(g.top.x, g.top.y)
    c.lineTo(g.head.x, g.head.y)
    c.stroke()
    c.strokeStyle = e.PAL.woodMid
    c.lineWidth = 0.05
    c.beginPath()
    c.moveTo(g.top.x, g.top.y)
    c.lineTo(g.head.x, g.head.y)
    c.stroke()
    /* bristles fanning on down the shaft's line */
    c.save()
    c.translate(g.head.x, g.head.y)
    c.rotate(Math.atan2(g.head.y - g.top.y, g.head.x - g.top.x))
    /* binding band */
    c.beginPath()
    if (typeof c.roundRect === "function") c.roundRect(-0.02, -0.07, 0.1, 0.14, 0.03)
    else c.rect(-0.02, -0.07, 0.1, 0.14)
    c.fillStyle = e.PAL.woodDark
    c.fill()
    /* straw fan */
    c.beginPath()
    c.moveTo(0.08, -0.09)
    c.lineTo(0.36, -0.15)
    c.lineTo(0.36, 0.15)
    c.lineTo(0.08, 0.09)
    c.closePath()
    c.fillStyle = e.PAL.wood
    c.fill()
    c.strokeStyle = e.PAL.woodMid
    c.lineWidth = 0.022
    for (let i = -3; i <= 3; i++) {
      c.beginPath()
      c.moveTo(0.1, i * 0.025)
      c.lineTo(0.36, i * 0.045)
      c.stroke()
    }
    c.restore()
    c.restore()
  }

  drawFront(_t: number, pose: PipPose) {
    const e = this.e
    const c = e.g
    if (!c || e.mode !== "sweep") return
    const g = this.geom(Math.sin(this.sweepPh))
    c.save()
    c.translate(pose.x, pose.y)
    c.rotate(pose.tilt)
    c.scale(pose.S * pose.sx * pose.face, pose.S * pose.sy)
    this.drawBroom(c, g)
    /* both hands wrap the shaft; drawPip skipped these arms (pose set grips) */
    armStroke(c, -0.4, 0.2, g.gUp.x, g.gUp.y, -0.12, e.PAL.outline, e.PAL.limb)
    armStroke(c, 0.4, 0.2, g.gLo.x, g.gLo.y, 0.12, e.PAL.outline, e.PAL.limb)
    this.handOn(c, g.gUp.x, g.gUp.y)
    this.handOn(c, g.gLo.x, g.gLo.y)
    c.restore()
  }

  pose(pose: PipPose, _t: number) {
    const e = this.e
    const sx = Math.sin(this.sweepPh)
    const g = this.geom(sx)
    pose.grip = g.gLo
    pose.gripB = g.gUp
    pose.gazeX = e.face * 0.5
    pose.gazeY = 0.7 /* eyes on the floor */
    pose.tilt += e.face * (0.05 + sx * 0.05) /* lean into the push */
    pose.y += Math.abs(sx) * e.Sc * 0.008
    pose.effort = Math.max(
      pose.effort,
      this.finishing ? 0.1 : 0.3 + Math.abs(Math.cos(this.sweepPh)) * 0.25,
    )
  }
}
