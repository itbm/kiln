import { rectOfEl } from "../anchors"
import type { PipEngine } from "../engine"
import { clamp, easeIO, easeOutBack, lerp, n1 } from "../math"
import type { PipAction, PipPose } from "../types"

/**
 * When a reply falls over, so does Pip (see lib/engine.ts → pip.mishap):
 *
 * - **"rate"** — a 429: he's been spun far too fast, so he goes **dizzy**.
 *   Staggers on the spot with his eyes rolling in circles and a ring of
 *   little stars orbiting his head, then shakes it off.
 * - **"error"** — anything else the stream threw: a proper **faint**. He
 *   reels, keels over backwards, lies there with his flame guttering down
 *   to a wisp of smoke, then comes to, sits up dazed and hops away.
 *
 * He is never left on his back: every phase is on a timer, and exit()
 * hands the mode over cleanly if something else needs him first.
 */
export class SwoonAction implements PipAction {
  id = "swoon"
  private kind: "dizzy" | "faint" = "faint"
  private phase: "drop" | "reel" | "topple" | "out" | "up" | "spin" = "reel"
  private phT = 0
  private phDur = 0.4
  private fallV = 0
  private groundY = 0
  private lieK = 0 /* 0 upright, 1 flat on his back */
  private shake = 0

  constructor(private e: PipEngine) {}

  begin(kind: "dizzy" | "faint") {
    const e = this.e
    e.leaveMode(true)
    e.clearAct(true)
    const wasHanging = e.mode === "pullup"
    e.mode = "swoon"
    this.kind = kind
    this.fallV = 0
    this.lieK = 0
    this.shake = 0
    e.windup = 0
    e.flareV = -2.2 /* the flame gutters at the bad news */
    /* he goes down where he stands — unless he was hanging off the header
       bar, in which case there's a drop to the ledge first */
    const comp = rectOfEl(document.querySelector('[data-pip-spot="composer"]'))
    const ledge = comp ? comp.top - e.S0 * 0.5 : e.H - 60
    this.groundY = e.py
    if (kind === "dizzy") this.enter("spin", 2.4 + Math.random() * 0.8)
    else if (wasHanging && ledge > e.py) {
      this.groundY = ledge
      this.enter("drop", 1.2)
    } else this.enter("reel", 0.42)
    for (let i = 0; i < 5; i++)
      e.drops.spawn(e.px, e.py - e.Sc * 0.4, false, e.PAL.smoke, 30)
  }

  private enter(phase: SwoonAction["phase"], dur: number) {
    this.phase = phase
    this.phT = 0
    this.phDur = dur
  }

  update(dt: number) {
    const e = this.e
    const Sc = e.Sc
    this.phT += dt
    this.shake = Math.max(0, this.shake - dt * 2)

    if (this.phase === "spin") {
      /* dizzy: staggering in place, seeing stars */
      e.px += Math.cos(this.phT * 4.6) * 26 * dt
      e.py += Math.sin(this.phT * 7.3) * 7 * dt
      if (Math.random() < dt * 2.4)
        e.drops.spawn(e.px, e.py - Sc * 1.15, false, e.PAL.smoke, 26)
      e.tiltExtra += Math.sin(this.phT * 5.2) * 0.16
      if (this.phT >= this.phDur) {
        /* shakes it off */
        e.flareV = 3
        e.gigPulse = 0.7
        this.shake = 1
        this.enter("up", 0.5)
      }
      return
    }

    if (this.phase === "drop") {
      /* he was hanging off the header bar — let go first */
      this.fallV += 1500 * dt
      e.py += this.fallV * dt
      e.tiltExtra += Math.sin(this.phT * 13) * 0.07
      if (e.py >= this.groundY || this.phT >= this.phDur) {
        e.py = Math.min(e.py, this.groundY)
        this.enter("topple", 0.42)
      }
      return
    }

    if (this.phase === "reel") {
      /* one step back, eyes wide — then his knees go */
      e.px -= e.face * 26 * dt
      e.tiltExtra += -e.face * 0.16 * Math.sin(clamp(this.phT / this.phDur, 0, 1) * Math.PI)
      if (this.phT >= this.phDur) this.enter("topple", 0.42)
      return
    }

    if (this.phase === "topple") {
      /* over he goes, landing flat with a puff of smoke */
      const k = clamp(this.phT / this.phDur, 0, 1)
      this.lieK = easeIO(k)
      e.py = lerp(this.groundY, this.groundY + Sc * 0.28, this.lieK)
      if (this.phT >= this.phDur) {
        for (let i = 0; i < 4; i++)
          e.drops.spawn(e.px + (Math.random() - 0.5) * Sc, e.py + Sc * 0.3, false, e.PAL.smoke, 34)
        e.flareV = -1.4
        this.enter("out", 1.5 + Math.random() * 0.9)
      }
      return
    }

    if (this.phase === "out") {
      /* lights out: the flame pinned down to a guttering wisp of smoke */
      this.lieK = 1
      e.flare = Math.min(e.flare, 0.62)
      e.flareV = 0
      if (Math.random() < dt * 2.6)
        e.drops.spawn(e.px + e.face * Sc * 0.5, e.py - Sc * 0.2, false, e.PAL.smoke, 40)
      if (this.phT >= this.phDur) {
        e.flareV = 2.2
        this.enter("up", 0.55)
      }
      return
    }

    /* up: back on his feet (or steady again), shaking his head clear */
    const k = clamp(this.phT / this.phDur, 0, 1)
    if (this.kind === "faint") {
      this.lieK = clamp(1 - easeOutBack(k), -0.12, 1)
      e.py = lerp(this.groundY + Sc * 0.28, this.groundY, easeIO(k))
      if (Math.random() < dt * 3) e.drops.spawn(e.px, e.py - Sc * 1.1, false)
    }
    this.shake = Math.max(this.shake, 1 - k)
    if (this.phT >= this.phDur) {
      e.flareV = 2.8
      this.recover(this.kind === "faint")
    }
  }

  /** back to normal service: dizzy settles where he stands, a faint sends
      him off to a fresh perch (nobody wants to lie about on the ledge) */
  private recover(move: boolean) {
    const e = this.e
    this.lieK = 0
    if (move) {
      e.startDart(e.pickNext())
      return
    }
    e.spot = e.spot ?? { x: e.px, y: e.py, s: e.scale, ride: false, w: 1 }
    e.enterRest()
  }

  exit() {
    this.lieK = 0
    this.shake = 0
  }

  pose(pose: PipPose, t: number) {
    if (this.kind === "faint") {
      /* flat on his back: a quarter turn away from the way he faces */
      pose.tilt -= pose.face * this.lieK * 1.45
      pose.lid = lerp(pose.lid, 0.07, this.lieK)
      pose.sy *= 1 - this.lieK * 0.08
      pose.effort = Math.max(pose.effort, this.lieK * 0.3)
      if (this.phase === "reel" || this.phase === "drop") {
        pose.startled = true
        pose.gazeY = -0.3
      } else {
        pose.gazeX = 0
        pose.gazeY = 0.1
      }
      if (this.phase === "out") pose.y += Math.sin(t * 2.2) * pose.S * 0.01
    } else {
      /* dizzy: eyes rolling, head lolling, heavy lids */
      const a = this.phT * 5.4
      pose.gazeX = Math.cos(a) * 0.9
      pose.gazeY = Math.sin(a) * 0.7
      pose.lid *= 0.62
      pose.effort = Math.max(pose.effort, 0.2)
    }
    if (this.shake > 0) pose.tilt += Math.sin(t * 34) * 0.06 * this.shake
  }

  /** front layer: the ring of stars — dizziness, and the daze after a faint */
  drawFront(t: number, pose: PipPose) {
    const e = this.e
    const c = e.g
    if (!c) return
    const k =
      this.kind === "dizzy"
        ? this.phase === "spin"
          ? 1
          : this.shake
        : this.phase === "up"
          ? this.shake
          : 0
    if (k < 0.05) return
    c.save()
    c.translate(pose.x, pose.y)
    c.rotate(pose.tilt)
    c.scale(pose.S * pose.sx * pose.face, pose.S * pose.sy)
    /* they orbit an ellipse above his crown, shrinking round the back */
    for (let i = 0; i < 4; i++) {
      const a = t * 3.4 + (i * Math.PI) / 2
      const x = Math.cos(a) * 0.66
      const y = -1.46 + Math.sin(a) * 0.16 + n1(t * 2 + i) * 0.02
      const s = (0.72 + 0.28 * Math.sin(a)) * k
      c.save()
      c.translate(x, y)
      c.rotate(a * 0.6)
      c.scale(s, s)
      c.beginPath()
      for (let p = 0; p < 8; p++) {
        const ang = (p * Math.PI) / 4
        const rr = p % 2 === 0 ? 0.16 : 0.06
        const px = Math.cos(ang) * rr
        const py = Math.sin(ang) * rr
        if (p === 0) c.moveTo(px, py)
        else c.lineTo(px, py)
      }
      c.closePath()
      c.fillStyle = e.PAL.innMid
      c.globalAlpha = clamp(k, 0, 1)
      c.fill()
      c.lineWidth = 0.035
      c.strokeStyle = e.PAL.innEdge
      c.stroke()
      c.restore()
    }
    c.globalAlpha = 1
    c.restore()
  }
}
