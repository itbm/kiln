import { zoneResolve } from "../anchors"
import type { PipEngine } from "../engine"
import type { PipAction } from "../types"

/** Strolling the composer ledge — amble, pause, change his mind, repeat. */
export class PatrolAction implements PipAction {
  id = "walk"
  private walkT = 0
  private walkDur = 6
  private walkDir = 1
  private walkSpd = 40

  constructor(private e: PipEngine) {}

  begin() {
    const e = this.e
    e.mode = "walk"
    this.walkT = 0
    e.walkPh = 0
    e.walkPause = 0
    /* calm ledge (open chat): a slow amble; the home floor keeps its bustle */
    const calm = !!e.spot?.calm
    this.walkDur = calm ? 7 + Math.random() * 5 : 4.5 + Math.random() * 4.5
    this.walkDir = Math.random() < 0.5 ? -1 : 1
    e.faceT = this.walkDir
    this.walkSpd = calm ? 13 + Math.random() * 8 : 34 + Math.random() * 16
  }

  /** shorter stroll — used after tumbling off the pull-up bar */
  beginShort() {
    this.begin()
    this.walkDur = 2.5 + Math.random() * 2
  }

  update(dt: number) {
    const e = this.e
    this.walkT += dt
    const fp = e.spot ? zoneResolve(e.spot, e.env) : null
    if (!fp) {
      e.startDart(e.pickNext())
      return
    }
    e.py += (fp.y - e.py) * (1 - Math.pow(0.002, dt))
    e.scale += ((fp.s || 0.8) - e.scale) * (1 - Math.pow(0.01, dt))
    const calm = !!e.spot?.calm
    let minX = (fp.minX ?? 30) + 4
    const maxX = (fp.maxX ?? e.W - 30) - 38
    /* mid-chat he sticks to the right part of the ledge */
    if (calm) minX += (maxX - minX) * 0.52
    if (e.walkPause > 0) {
      e.walkPause -= dt
    } else {
      e.px += this.walkDir * this.walkSpd * dt
      /* step cadence follows speed, so the calm amble doesn't moonwalk */
      e.walkPh += dt * this.walkSpd * 0.2
      if (e.px < minX) this.turn(1)
      else if (e.px > maxX) this.turn(-1)
      else if (Math.random() < dt * (calm ? 0.34 : 0.22))
        e.walkPause = calm
          ? 0.9 + Math.random() * 1.7
          : 0.5 + Math.random() * 0.9
      else if (Math.random() < dt * 0.1) this.turn(-this.walkDir)
    }
    if (e.veryNear && !e.isTouch)
      e.startDart(e.pickNext(e.mouseX, e.mouseY))
    else if (this.walkT > this.walkDur) e.startDart(e.pickNext())
  }

  private turn(dir: number) {
    this.walkDir = dir
    this.e.faceT = dir
  }
}
