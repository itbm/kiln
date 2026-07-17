import { resolveSpot } from "../anchors"
import type { PipEngine } from "../engine"
import type { PipAction } from "../types"

/**
 * Resting on a perch: breathe, hold position against layout shifts, dodge
 * a prowling pointer, and — on the home ring — put on ring acts
 * (axe throwing and friends, see the other files in this folder).
 */
export class RestAction implements PipAction {
  id = "rest"
  constructor(private e: PipEngine) {}

  update(dt: number, t: number) {
    const e = this.e
    e.restT += dt
    const p = resolveSpot(e.spot, e.env)
    if (!p || p.y < 16 || p.y > e.H - 26 || p.x < 20 || p.x > e.W - 8) {
      e.startDart(e.pickNext())
    } else {
      const kf = 1 - Math.pow(0.002, dt)
      e.px += (p.x - e.px) * kf
      e.py += (p.y - e.py) * kf
      e.scale += ((p.s || 1) - e.scale) * kf
      if (e.veryNear && !e.isTouch && e.anger < 0.4) {
        if (e.nearSince < 0) e.nearSince = t
        if (t - e.nearSince > 0.55) {
          e.nearSince = -1
          e.startDart(e.pickNext(e.mouseX, e.mouseY))
          return
        }
      } else e.nearSince = -1
      if (e.restT > e.restDur && e.eepT < 0 && e.act === "") {
        e.startDart(e.pickNext())
        return
      }
    }

    /* ring acts: axe throwing & friends */
    if (e.spot?.zone === "ring" && e.eepT < 0 && e.anger < 0.3) {
      if (e.act === "" && !e.near) {
        e.ringActNext -= dt
        if (e.ringActNext <= 0) {
          if (Math.random() < 0.7) {
            e.startRingAct(t)
          } else {
            e.antic = ["giggle", "hop", "flare"][Math.floor(Math.random() * 3)]
            e.anticT = 0
            if (e.antic === "flare") e.flareV = 3.2
          }
          e.ringActNext = 3.5 + Math.random() * 3
        }
      } else if (e.act !== "" && e.near) {
        e.clearAct(true)
      }
    }
    if (e.act !== "") {
      const act = e.actions.ringActs.find((a) => a.id === e.act)
      act?.update(dt, t)
    }
  }
}
