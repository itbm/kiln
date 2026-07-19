import { elSpots, rectOfEl } from "../anchors"
import type { PipEngine } from "../engine"
import { clamp, lerp } from "../math"
import type { PipAction, PipPose } from "../types"

const siteEl = () => document.querySelector('[data-art-generating="true"]')

/**
 * Foreman Pip: while an artefact card streams in he stands on its top edge
 * and "builds" it — hammer up, a few strikes with spark showers, an
 * approving look at the work, a scoot along the edge, repeat. The moment
 * the card finishes (its data-art-generating flag clears) he darts back
 * down to the composer ledge. He's sent up here by the engine's site check
 * (engine.tick) and DartAction hands over on landing.
 */
export class BuildAction implements PipAction {
  id = "build"
  private phase: "raise" | "strike" | "inspect" | "scoot" = "raise"
  private phT = 0
  private phDur = 0.3
  private wx = 0.7 /* work position, fraction along the card's top edge */
  private txf = 0.7 /* scoot destination fraction */
  private strikes = 2
  /* hammer angle around his forward hand: ~0.3 = raised beside his head
     (in open air, clear of his silhouette — it draws *under* him),
     ~1.9 = slammed down on the surface ahead */
  private ang = 0.5
  private hitK = 0 /* impact squash envelope */
  private scootPh = 0

  constructor(private e: PipEngine) {}

  begin() {
    const e = this.e
    e.mode = "build"
    e.clearAct(true)
    const r = rectOfEl(siteEl())
    this.wx = r ? clamp((e.px - r.left) / r.width, 0.18, 0.85) : 0.7
    e.faceT = this.wx > 0.55 ? -1 : 1 /* hammer toward the card's middle */
    this.strikes = 2 + Math.floor(Math.random() * 2)
    this.ang = 0.5
    this.hitK = 0
    this.enter("raise", 0.3)
  }

  private enter(phase: BuildAction["phase"], dur: number) {
    this.phase = phase
    this.phT = 0
    this.phDur = dur
  }

  private bout() {
    this.strikes = 2 + Math.floor(Math.random() * 2)
    this.enter("raise", 0.26)
  }

  private scootOff(w: number) {
    let f = 0.18 + Math.random() * 0.67
    /* make it a real walk, not a shuffle on the spot */
    if (Math.abs(f - this.wx) * w < 60)
      f = this.wx > 0.5 ? this.wx - 60 / w : this.wx + 60 / w
    this.txf = clamp(f, 0.15, 0.88)
    this.scootPh = 0
    this.enter("scoot", 9) /* duration is a safety cap; ends on arrival */
  }

  update(dt: number, t: number) {
    const e = this.e
    this.phT += dt
    this.hitK = Math.max(0, this.hitK - dt * 7)
    const r = rectOfEl(siteEl())
    const comp = rectOfEl(document.querySelector('[data-pip-spot="composer"]'))
    const S = e.S0
    /* card finished, covered by an overlay, or scrolled out of reach →
       straight back down to the ledge */
    if (
      !r ||
      !comp ||
      r.top < 54 ||
      r.top > comp.top - S * 0.9 ||
      document.querySelector('[data-slot="drawer-content"], [data-slot="dialog-content"]')
    ) {
      this.done()
      return
    }
    /* ride the card's top edge (it drifts as the chat streams) */
    const footY = r.top - S * 0.66 * 0.52
    const tx = clamp(r.left + this.wx * r.width, r.left + 16, r.right - 12)
    const kf = 1 - Math.pow(0.0008, dt)
    e.px += (tx - e.px) * kf
    e.py += (footY - e.py) * kf
    e.scale += (0.66 - e.scale) * (1 - Math.pow(0.01, dt))
    /* keep his flame trail alive (the engine only auto-spawns at rest) */
    if (Math.random() < dt * 1.5) e.drops.spawn(e.px, e.py - e.Sc * 1.05, false)

    if (this.phase === "raise") {
      this.ang +=
        (0.3 + Math.sin(t * 9) * 0.07 - this.ang) *
        (1 - Math.pow(0.002, dt))
      if (this.phT >= this.phDur) this.enter("strike", 0.13)
    } else if (this.phase === "strike") {
      const k = clamp(this.phT / this.phDur, 0, 1)
      this.ang = lerp(0.3, 1.9, k * k)
      if (this.phT >= this.phDur) {
        /* clang! */
        this.hitK = 1
        e.flareV = 2
        const hx = e.px + e.face * e.Sc * 1.05
        for (let i = 0; i < 4; i++) e.drops.spawn(hx, r.top - 1, true)
        e.drops.spawn(hx, r.top - 1, true, e.PAL.wood)
        if (--this.strikes > 0) this.enter("raise", 0.26)
        else if (Math.random() < 0.4)
          this.enter("inspect", 0.8 + Math.random() * 0.7)
        else this.scootOff(r.width)
      }
    } else if (this.phase === "inspect") {
      this.ang += (0.5 - this.ang) * (1 - Math.pow(0.002, dt))
      if (this.phT >= this.phDur) {
        if (Math.random() < 0.5) this.bout()
        else this.scootOff(r.width)
      }
    } else {
      /* scoot: carry the hammer along to the next work spot */
      this.ang += (0.5 - this.ang) * (1 - Math.pow(0.002, dt))
      this.scootPh += dt * 7
      const step = (52 / Math.max(r.width, 1)) * dt
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
    e.windup = 0
    e.gigPulse = 0.9 /* proud of his work */
    e.flareV = 2.4
    const home = elSpots(e.env).find((p) => p.home)
    e.startDart(home ?? e.pickNext())
  }

  /** the mallet, pivoted at his forward hand (drawn just beneath him,
      angled up-forward so it stays clear of his silhouette) */
  draw() {
    const e = this.e
    const c = e.g
    if (!c || e.mode !== "build") return
    const U = e.Sc
    const f = e.face < 0 ? -1 : 1
    c.save()
    c.translate(e.px + f * U * 0.6, e.py + U * 0.02)
    c.scale(f, 1)
    c.rotate(this.ang)
    const hl = U * 0.72
    c.lineCap = "round"
    c.lineJoin = "round"
    c.strokeStyle = e.PAL.woodDark
    c.lineWidth = U * 0.12
    c.beginPath()
    c.moveTo(0, U * 0.12)
    c.lineTo(0, -hl)
    c.stroke()
    c.strokeStyle = e.PAL.wood
    c.lineWidth = U * 0.075
    c.beginPath()
    c.moveTo(0, U * 0.1)
    c.lineTo(0, -hl + U * 0.04)
    c.stroke()
    const hw = U * 0.46
    const hh = U * 0.26
    c.beginPath()
    c.rect(-hw * 0.4, -hl - hh / 2, hw, hh)
    c.fillStyle = e.PAL.steel
    c.fill()
    c.lineWidth = U * 0.05
    c.strokeStyle = e.PAL.steelEdge
    c.stroke()
    c.restore()
  }

  pose(pose: PipPose) {
    const e = this.e
    pose.gazeX = e.face * 0.45
    pose.gazeY = this.phase === "scoot" ? 0.15 : 0.5
    pose.tilt += e.face * (this.phase === "strike" ? 0.09 : 0.04)
    if (this.phase === "scoot")
      pose.y -= Math.abs(Math.sin(this.scootPh)) * e.Sc * 0.05
    pose.sy *= 1 - this.hitK * 0.1
    pose.sx *= 1 + this.hitK * 0.06
    pose.effort = Math.max(pose.effort, this.hitK * 0.6)
  }
}
