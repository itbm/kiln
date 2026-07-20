import { elSpots, rectOfEl } from "../anchors"
import { armStroke } from "../draw/pip"
import type { PipEngine } from "../engine"
import { clamp, easeIO, easeOutBack, lerp, n1 } from "../math"
import type { PipAction, PipPose } from "../types"

const siteEl = () =>
  document.querySelector('[data-art-generating="true"]') as HTMLElement | null

/**
 * Per-card site diary, keyed on the DOM node: how long Pip has been working
 * this card, which tool he's on and when the next heave is due. Keeping it
 * outside the action means popping off for an overlay and darting back
 * doesn't reset the clock, so a 40-second generation still earns its heave.
 */
interface SiteLog {
  t: number
  tool: number
  swapAt: number
  heaveAt: number
}
const siteLogs = new WeakMap<Element, SiteLog>()

const TOOLS = ["hammer", "saw", "drill"] as const
const HEAVE_AT = 30 /* seconds of building before he picks the card up */
const SWAP_EVERY = () => 8 + Math.random() * 5

/**
 * Foreman Pip: while an artefact card streams in he stands on its top edge
 * — hard hat on, naturally — and "builds" it, cycling through his toolkit
 * as the job drags on: hammer strikes with spark showers, then a hand saw
 * (wood chips fly), then a little two-handed drill pumping into the edge.
 * The moment the card finishes (its data-art-generating flag clears) he
 * darts back down to the composer ledge. He's sent up here by the engine's
 * site check (engine.tick) and DartAction hands over on landing.
 *
 * Past the 30-second mark the job is officially Taking Ages, so he lodges
 * a complaint with physics: grabs the top edge, fires up the jetpack and
 * airlifts the actual card — a real CSS transform on the DOM node. Given
 * headroom he takes it right up to just under the header (ascend), kills
 * the engines, pops a parachute and pendulum-drifts the whole rig back
 * down (chute) before plonking it home with a bounce; in a cramped
 * viewport he falls back to a low hover-and-sway (carry). The transform
 * is decorative and is always undone: on completion, on any exit path
 * (done/exit), and exit() is invoked by whoever steals the mode (see
 * engine.leaveMode).
 */
export class BuildAction implements PipAction {
  id = "build"
  private phase:
    | "raise"
    | "strike"
    | "saw"
    | "drill"
    | "inspect"
    | "scoot"
    | "grab"
    | "hoist"
    | "ascend"
    | "chute"
    | "carry"
    | "plonk" = "raise"
  private phT = 0
  private phDur = 0.3
  private wx = 0.7 /* work position, fraction along the card's top edge */
  private txf = 0.7 /* scoot destination fraction */
  private strikes = 2
  /* hammer angle around the gripping hand: ~0.3 = head up beside his own,
     ~1.9 = slammed down on the surface ahead (front layer, in-hand) */
  private ang = 0.5
  private hitK = 0 /* impact squash envelope */
  private scootPh = 0
  private sawPh = 0
  private sawOff = 0 /* stroke offset, -1..1 along the blade */
  private jit = 0 /* drill pump, unit space (drives drill + hands + card) */
  private log: SiteLog = { t: 0, tool: 0, swapAt: 10, heaveAt: HEAVE_AT }
  /* the heave: offsets we are currently applying to the real card */
  private card: HTMLElement | null = null
  private cdx = 0
  private cdy = 0
  private crot = 0
  private lift = 12
  private jetK = 0
  private thenGrab = false /* current scoot ends in a grab, not a bout */
  private cdxPrev = 0
  /* the parachute ride */
  private ascendH = 0 /* how high above its resting spot the card goes */
  private canopyK = 0 /* canopy deployment/fold envelope */
  private deployT = 0
  private jetAtPlonk = 1 /* jet flame left when the plonk starts */

  constructor(private e: PipEngine) {}

  begin() {
    const e = this.e
    e.mode = "build"
    e.clearAct(true)
    const el = siteEl()
    const r = rectOfEl(el)
    if (el) this.logFor(el)
    this.wx = r ? clamp((e.px - r.left) / r.width, 0.18, 0.85) : 0.7
    e.faceT = this.wx > 0.55 ? -1 : 1 /* work toward the card's middle */
    this.strikes = 2 + Math.floor(Math.random() * 2)
    this.ang = 0.5
    this.hitK = 0
    this.jetK = 0
    this.thenGrab = false
    this.bout() /* opens with whichever tool this card's diary says */
  }

  private enter(phase: BuildAction["phase"], dur: number) {
    this.phase = phase
    this.phT = 0
    this.phDur = dur
  }

  private carrying(): boolean {
    return (
      this.phase === "grab" ||
      this.phase === "hoist" ||
      this.phase === "ascend" ||
      this.phase === "chute" ||
      this.phase === "carry" ||
      this.phase === "plonk"
    )
  }

  /** point this.log at the card's diary, starting one for a new card */
  private logFor(el: Element) {
    let log = siteLogs.get(el)
    if (!log) {
      log = { t: 0, tool: 0, swapAt: SWAP_EVERY(), heaveAt: HEAVE_AT }
      siteLogs.set(el, log)
    }
    this.log = log
  }

  /* ---------- the card in his hands (decorative DOM transform) ---------- */

  private grip(el: HTMLElement) {
    if (this.card === el) return
    this.release()
    this.card = el
    /* we drive the transform per-frame; the card's class transition would
       smear each step 150ms behind, so park it while we hold on */
    el.style.transition = "none"
    el.style.willChange = "transform"
  }

  private setCard(dx: number, dy: number, rot: number) {
    this.cdx = dx
    this.cdy = dy
    this.crot = rot
    if (this.card)
      this.card.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) rotate(${rot.toFixed(3)}deg)`
  }

  /** put the card back: the class transition is restored first, so whatever
      offset remains settles home smoothly (150ms) instead of snapping */
  private release() {
    const el = this.card
    this.card = null
    this.cdx = this.cdy = this.crot = 0
    if (!el) return
    el.style.transition = ""
    el.style.transform = ""
    el.style.willChange = ""
  }

  /* ---------- bout plumbing ---------- */

  private bout() {
    /* a fresh work bout; the toolbelt moment — swap tools when one's due */
    if (this.log.t >= this.log.swapAt) {
      this.log.tool = (this.log.tool + 1) % TOOLS.length
      this.log.swapAt = this.log.t + SWAP_EVERY()
      this.e.flareV = 2.2 /* pleased little flare for the new toy */
    }
    const tool = TOOLS[this.log.tool]
    if (tool === "hammer") {
      this.strikes = 2 + Math.floor(Math.random() * 2)
      this.enter("raise", 0.26)
    } else if (tool === "saw") {
      this.sawPh = 0
      this.enter("saw", 2.4 + Math.random() * 1.2)
    } else {
      this.enter("drill", 1.1 + Math.random() * 0.6)
    }
  }

  /** end-of-bout decision: heave when it's due, otherwise potter on */
  private nextUp(w: number) {
    if (this.log.t >= this.log.heaveAt) {
      /* walk to the middle first — heaving from a corner reads wrong */
      this.thenGrab = true
      this.scootTo(0.38 + Math.random() * 0.24, w)
      return
    }
    const dizzy = this.phase === "drill" ? 0.6 : 0.4
    if (Math.random() < dizzy)
      this.enter("inspect", 0.8 + Math.random() * 0.7)
    else this.scootOff(w)
  }

  private scootTo(f: number, w: number) {
    /* make it a real walk, not a shuffle on the spot */
    if (Math.abs(f - this.wx) * w < 60)
      f = this.wx > 0.5 ? this.wx - 60 / w : this.wx + 60 / w
    this.txf = clamp(f, 0.15, 0.88)
    this.scootPh = 0
    this.enter("scoot", 9) /* duration is a safety cap; ends on arrival */
  }

  private scootOff(w: number) {
    this.scootTo(0.18 + Math.random() * 0.67, w)
  }

  update(dt: number, t: number) {
    const e = this.e
    this.phT += dt
    this.hitK = Math.max(0, this.hitK - dt * 7)
    const el = siteEl()
    const r = rectOfEl(el)
    const comp = rectOfEl(document.querySelector('[data-pip-spot="composer"]'))
    const S = e.S0
    /* card finished, covered by an overlay, or scrolled out of reach →
       straight back down to the ledge. Judge by where the card RESTS
       (r includes our own transform, which mid-ride is a big lift). */
    const restTop = r ? r.top - this.cdy : 0
    if (
      !el ||
      !r ||
      !comp ||
      restTop < 54 ||
      restTop > comp.top - S * 0.9 ||
      document.querySelector('[data-slot="drawer-content"], [data-slot="dialog-content"]')
    ) {
      this.done()
      return
    }
    /* a different card took over mid-heave (rare) — put the old one down */
    if (this.card && this.card !== el && this.carrying()) {
      this.release()
      this.thenGrab = false
      this.enter("raise", 0.3)
    }
    this.logFor(el)
    this.log.t += dt

    /* ride the card's top edge (it drifts as the chat streams; while he
       holds it, the rect already includes our own transform — he and the
       card move as one). Airborne he tracks the edge rigidly: smoothing
       would leave him trailing behind the climb. */
    const footY = r.top - S * 0.66 * 0.52
    const tx = clamp(r.left + this.wx * r.width, r.left + 16, r.right - 12)
    const airborne =
      this.phase === "hoist" ||
      this.phase === "ascend" ||
      this.phase === "chute" ||
      this.phase === "carry" ||
      this.phase === "plonk"
    const kf = airborne ? 1 : 1 - Math.pow(0.0008, dt)
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
        else this.nextUp(r.width)
      }
    } else if (this.phase === "saw") {
      /* push, pull, push — chips fly while the blade is moving fast */
      this.sawPh += dt * 6.5
      this.sawOff = Math.sin(this.sawPh)
      const speed = Math.abs(Math.cos(this.sawPh))
      if (speed > 0.5 && Math.random() < dt * 5) {
        const hx = e.px + e.face * e.Sc * 0.95 /* where blade meets the edge */
        e.drops.spawn(hx, r.top - 1, true, Math.random() < 0.5 ? e.PAL.wood : e.PAL.woodMid, 12)
      }
      if (Math.random() < dt * 1.2) e.flareV = 1.6
      if (this.phT >= this.phDur) {
        this.sawOff = 0
        this.nextUp(r.width)
      }
    } else if (this.phase === "drill") {
      /* brrrrRRT — drill, hands and card all judder as one (the card
         only a little, and let go of smoothly) */
      this.jit = n1(t * 45) * 0.05
      this.grip(el)
      this.setCard(n1(t * 44) * 0.7, Math.abs(n1(t * 51)) * 0.5, 0)
      e.flareV = Math.max(e.flareV, 1.4)
      const hx = e.px + e.face * e.Sc * 0.55 /* the bit's tip */
      if (Math.random() < dt * 16) e.drops.spawn(hx, r.top - 1, true)
      if (Math.random() < dt * 3)
        e.drops.spawn(hx, r.top - 4, false, e.PAL.smoke, 40)
      if (this.phT >= this.phDur) {
        this.jit = 0
        this.release()
        this.nextUp(r.width)
      }
    } else if (this.phase === "inspect") {
      this.ang += (0.5 - this.ang) * (1 - Math.pow(0.002, dt))
      if (this.phT >= this.phDur) {
        if (Math.random() < 0.5) this.bout()
        else this.scootOff(r.width)
      }
    } else if (this.phase === "scoot") {
      /* carry the tool along to the next work spot */
      this.ang += (0.5 - this.ang) * (1 - Math.pow(0.002, dt))
      this.scootPh += dt * 7
      const step = (52 / Math.max(r.width, 1)) * dt
      const d = this.txf - this.wx
      e.faceT = d > 0 ? 1 : -1
      if (Math.abs(d) <= step || this.phT > this.phDur) {
        this.wx = this.txf
        e.faceT = this.wx > 0.55 ? -1 : 1
        if (this.thenGrab) {
          this.thenGrab = false
          this.enter("grab", 0.45)
        } else this.bout()
      } else this.wx += Math.sign(d) * step
    } else if (this.phase === "grab") {
      /* tools down, crouch, get a grip on the top edge */
      if (this.phT >= this.phDur) {
        this.grip(el)
        this.lift = clamp(S * 0.35, 9, 14)
        this.enter("hoist", 0.75)
      }
    } else if (this.phase === "hoist") {
      /* jetpack spooling up, card creaking off the ground */
      const k = easeIO(clamp(this.phT / this.phDur, 0, 1))
      this.grip(el)
      this.jetK = k
      this.setCard(0, -this.lift * k, n1(t * 17) * 0.4 * k)
      if (Math.random() < dt * 6)
        e.drops.spawn(e.px + e.face * e.Sc * 0.35, e.py - e.Sc * 0.7, false, e.PAL.sweat, 20)
      if (Math.random() < dt * 24 * k)
        e.drops.spawn(e.px - e.face * e.Sc * 0.55, e.py + e.Sc * 0.5, false, null, 10)
      if (this.phT >= this.phDur) {
        this.cdxPrev = 0
        /* headroom decides the show: enough sky → full parachute ride up
           to just under the header (the margin leaves space for Pip and
           the canopy above the card); cramped → the old low hover-and-sway */
        const room = restTop - (54 + S * 2)
        if (room > 70) {
          this.ascendH = clamp(room, 70, e.H * 0.55)
          this.enter("ascend", clamp(this.ascendH / 230, 0.8, 1.8))
        } else this.enter("carry", 3.2 + Math.random() * 1.4)
      }
    } else if (this.phase === "ascend") {
      /* full throttle: haul the card up toward the header */
      const k = easeIO(clamp(this.phT / this.phDur, 0, 1))
      this.grip(el)
      this.jetK = 1
      this.setCard(
        n1(t * 2.1) * 4 * k,
        -lerp(this.lift, this.ascendH, k),
        clamp(n1(t * 2.6) * 0.8 * k, -2, 2),
      )
      if (Math.random() < dt * 34)
        e.drops.spawn(e.px - e.face * e.Sc * 0.55, e.py + e.Sc * 0.5, false, null, 10)
      if (this.phT >= this.phDur) {
        this.deployT = 0
        this.cdxPrev = this.cdx
        this.enter("chute", clamp(this.ascendH / 105, 1.6, 3.8))
      }
    } else if (this.phase === "chute") {
      /* engines off, canopy pops — pendulum-drift the rig back down */
      const k = clamp(this.phT / this.phDur, 0, 1)
      this.grip(el)
      this.jetK = Math.max(0, this.jetK - dt * 5)
      this.deployT += dt
      this.canopyK = easeOutBack(clamp(this.deployT / 0.4, 0, 1))
      const sway = Math.min(26, r.width * 0.08) * this.canopyK
      const dx = Math.sin(this.phT * 4.3) * sway * (1 - k * 0.35)
      const dy = -lerp(this.ascendH, this.lift, easeIO(k))
      const rot = clamp(-dx * 0.055 + n1(t * 1.9) * 0.3, -3, 3)
      this.setCard(dx, dy, rot)
      const vx = dx - this.cdxPrev
      if (Math.abs(vx) > 0.12) e.faceT = vx > 0 ? 1 : -1
      this.cdxPrev = dx
      if (this.phT >= this.phDur) {
        this.jetAtPlonk = this.jetK
        this.enter("plonk", 0.55)
      }
    } else if (this.phase === "carry") {
      /* airborne removals: sway the card about, then bring it home */
      const u = clamp(this.phT / this.phDur, 0, 1)
      const env = clamp(Math.sin(u * Math.PI) * 1.5, 0, 1)
      const swayA = Math.min(30, r.width * 0.085)
      const dx = swayA * Math.sin(u * Math.PI * 2 * 2.2) * env
      const dy = -this.lift + Math.sin(u * Math.PI * 4 + 0.7) * 1.8 * env
      const rot = clamp(-dx * 0.045 + n1(t * 2.6) * 0.35, -2.2, 2.2)
      this.grip(el)
      this.jetK = 1
      this.setCard(dx, dy, rot)
      const vx = dx - this.cdxPrev
      if (Math.abs(vx) > 0.12) e.faceT = vx > 0 ? 1 : -1
      this.cdxPrev = dx
      if (Math.random() < dt * 26)
        e.drops.spawn(e.px - e.face * e.Sc * 0.55, e.py + e.Sc * 0.5, false, null, 10)
      if (this.phT >= this.phDur) {
        this.jetAtPlonk = 1
        this.enter("plonk", 0.55)
      }
    } else {
      /* plonk: down she goes, with a little bounce on arrival (after a
         chute ride the jet is already out and the canopy folds away) */
      const k = clamp(this.phT / this.phDur, 0, 1)
      const b = easeOutBack(k) /* overshoots past 1 → a squash-down dip */
      this.jetK = this.jetAtPlonk * (1 - k)
      this.canopyK = Math.max(0, this.canopyK - dt * 5)
      this.setCard(this.cdx * (1 - k * k), -this.lift * (1 - b), this.crot * (1 - k))
      if (this.phT >= this.phDur) {
        this.hitK = 1
        e.flareV = 2.5
        e.gigPulse = 0.9
        for (let i = 0; i < 5; i++)
          e.drops.spawn(e.px + (Math.random() - 0.5) * e.Sc, r.top - 1, true)
        this.release()
        this.log.heaveAt = this.log.t + 24 + Math.random() * 12
        this.enter("inspect", 0.9) /* admire the landing */
      }
    }
  }

  private done() {
    const e = this.e
    this.release()
    this.thenGrab = false
    this.jetK = 0
    this.canopyK = 0
    this.deployT = 0
    e.windup = 0
    e.gigPulse = 0.9 /* proud of his work */
    e.flareV = 2.4
    const home = elSpots(e.env).find((p) => p.home)
    e.startDart(home ?? e.pickNext())
  }

  /** another action is taking the mode over (dart, drawer hit, teardown) —
      whatever happens, the card goes back where it belongs */
  exit() {
    this.release()
    this.thenGrab = false
    this.jetK = 0
    this.canopyK = 0
    this.deployT = 0
  }

  /* ---------- the toolkit (front layer: in his hands, over his body) ----------
     pose() flags the gripping hand via pose.grip (drawPip then skips that
     arm), and drawFront draws tool first, then the arm + hand OVER its
     handle — so arm, hand and tool always coincide. draw() (the back
     layer) stays free for scenery. */

  /** forward-hand position for the current tool & phase, in unit space
      (+x = the way he faces, y down, body ≈ 2 units tall) */
  private toolGrip(): { x: number; y: number } {
    const tool = TOOLS[this.log.tool]
    if (tool === "hammer") {
      if (this.phase === "strike") {
        const k = clamp(this.phT / this.phDur, 0, 1) ** 2
        return { x: lerp(0.36, 0.62, k), y: lerp(-0.48, 0.1, k) }
      }
      if (this.phase === "raise") return { x: 0.36, y: -0.48 }
      return { x: 0.52, y: 0.3 } /* carried along between bouts */
    }
    if (tool === "saw") {
      /* hand inside the D-grip; strokes slide it along the blade axis */
      const off = this.phase === "saw" ? this.sawOff * 0.15 : 0
      return { x: 0.6 + off * 0.68, y: 0.26 + off * 0.73 }
    }
    /* drill: front end of the T-bar while it runs (both hands ride the
       pumping bar — gripB takes the back end), else lugged along */
    if (this.phase === "drill") return { x: 0.8, y: -0.02 + this.jit }
    return { x: 0.62, y: 0.15 }
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

  /** safety first: a yellow hard hat perched on the flame crown (unit
      space; it inherits every lean and squash from the pose transform) */
  private drawHardHat(c: CanvasRenderingContext2D) {
    c.save()
    c.lineJoin = "round"
    /* dome */
    c.beginPath()
    c.moveTo(-0.4, -0.68)
    c.bezierCurveTo(-0.43, -1.02, -0.2, -1.13, 0, -1.13)
    c.bezierCurveTo(0.2, -1.13, 0.43, -1.02, 0.4, -0.68)
    c.closePath()
    c.fillStyle = "#FFC93C"
    c.fill()
    c.lineWidth = 0.05
    c.strokeStyle = "#9C6A0A"
    c.stroke()
    /* centre ridge */
    c.beginPath()
    if (typeof c.roundRect === "function")
      c.roundRect(-0.08, -1.19, 0.16, 0.12, 0.05)
    else c.rect(-0.08, -1.19, 0.16, 0.12)
    c.fillStyle = "#FFC93C"
    c.fill()
    c.lineWidth = 0.04
    c.stroke()
    /* brim over the dome's base */
    c.beginPath()
    c.ellipse(0, -0.66, 0.55, 0.095, 0, 0, 6.2832)
    c.fillStyle = "#F5AE1E"
    c.fill()
    c.lineWidth = 0.045
    c.stroke()
    /* a little shine */
    c.beginPath()
    c.ellipse(-0.16, -0.97, 0.09, 0.05, -0.5, 0, 6.2832)
    c.fillStyle = "rgba(255,255,255,.4)"
    c.fill()
    c.restore()
  }

  /** the parachute: cream canopy with kiln-orange gores, risers down to
      his raised hands. Scales with canopyK so it pops open and folds. */
  private drawChute(c: CanvasRenderingContext2D, t: number) {
    const k = clamp(this.canopyK, 0, 1.15)
    if (k < 0.04) return
    const e = this.e
    const canopy = () => {
      c.beginPath()
      c.moveTo(-1.0, -1.04)
      c.bezierCurveTo(-1.06, -1.78, -0.48, -1.98, 0, -1.98)
      c.bezierCurveTo(0.48, -1.98, 1.06, -1.78, 1.0, -1.04)
      /* scalloped hem */
      for (let i = 0; i < 4; i++)
        c.quadraticCurveTo(0.75 - i * 0.5, -0.9, 0.5 - i * 0.5, -1.04)
      c.closePath()
    }
    c.save()
    /* hangs from his hands; a touch of counter-sway against the drift */
    c.translate(0, -0.62)
    c.rotate(n1(t * 1.4) * 0.05 - this.cdx * 0.004)
    c.scale(k, k)
    c.lineCap = "round"
    c.lineJoin = "round"
    /* risers */
    c.lineWidth = 0.035
    c.strokeStyle = e.PAL.steelEdge
    for (const s of [-1, 1]) {
      c.beginPath()
      c.moveTo(s * 0.44, 0.02)
      c.lineTo(s * 0.97, -1.03)
      c.stroke()
    }
    /* canopy fill, gores clipped inside, outline last */
    canopy()
    c.fillStyle = e.PAL.innIn
    c.fill()
    c.save()
    c.clip()
    c.fillStyle = e.PAL.bodyMid
    c.globalAlpha = 0.8
    for (const s of [-1, 0, 1]) {
      c.beginPath()
      c.moveTo(s * 0.2 - 0.11, -1.94)
      c.quadraticCurveTo(s * 0.55 - 0.14, -1.5, s * 0.62 - 0.16, -0.92)
      c.lineTo(s * 0.62 + 0.16, -0.92)
      c.quadraticCurveTo(s * 0.55 + 0.14, -1.5, s * 0.2 + 0.11, -1.94)
      c.closePath()
      c.fill()
    }
    c.restore()
    canopy()
    c.lineWidth = 0.05
    c.strokeStyle = e.PAL.outline
    c.stroke()
    c.restore()
  }

  drawFront(t: number, pose: PipPose) {
    const e = this.e
    const c = e.g
    if (!c || e.mode !== "build") return
    const grabbing = this.phase === "grab"
    c.save()
    /* the same transform drawPip uses, so grip points line up exactly and
       held things lean/squash with his body */
    c.translate(pose.x, pose.y)
    c.rotate(pose.tilt)
    c.scale(pose.S * pose.sx * pose.face, pose.S * pose.sy)
    /* the site uniform: hard hat stays on through every phase */
    this.drawHardHat(c)
    const g = pose.grip ?? this.toolGrip()
    if (
      this.phase === "chute" ||
      (this.phase === "plonk" && this.canopyK > 0.04)
    ) {
      /* canopy and risers first, then both arms reach up to the toggles
         (the canopy keeps folding through the start of the plonk) */
      this.drawChute(c, t)
      if (pose.gripB)
        armStroke(c, -0.4, 0.2, pose.gripB.x, pose.gripB.y, -0.14, e.PAL.outline, e.PAL.limb)
      armStroke(c, 0.4, 0.2, g.x, g.y, 0.14, e.PAL.outline, e.PAL.limb)
      if (pose.gripB) this.handOn(c, pose.gripB.x, pose.gripB.y)
      this.handOn(c, g.x, g.y)
      c.restore()
      return
    }
    if (this.carrying() && !grabbing) {
      /* hoist/ascend/carry/plonk: hands are full of card, jet arms are
         drawPip's — nothing more to add over him */
      c.restore()
      return
    }
    if (grabbing) {
      /* no tool — both arms reach down over the card's top edge */
      if (pose.gripB)
        armStroke(c, -0.4, 0.2, pose.gripB.x, pose.gripB.y, 0.16, e.PAL.outline, e.PAL.limb)
      armStroke(c, 0.4, 0.2, g.x, g.y, 0.1, e.PAL.outline, e.PAL.limb)
      c.restore()
      return
    }
    const tool = TOOLS[this.log.tool]
    if (tool === "drill") {
      /* sandwich hold: arms reach behind the drill, closed hands wrap
         over the T-bar — the drill sits IN his hands */
      if (pose.gripB)
        armStroke(c, -0.4, 0.2, pose.gripB.x, pose.gripB.y, 0.16, e.PAL.outline, e.PAL.limb)
      armStroke(c, 0.4, 0.2, g.x, g.y, 0.12, e.PAL.outline, e.PAL.limb)
      this.drawDrill(c)
      if (pose.gripB) {
        this.handOn(c, pose.gripB.x, pose.gripB.y)
        this.handOn(c, g.x, g.y)
      } else this.handOn(c, g.x, g.y)
    } else {
      /* hammer/saw: tool first, gripping arm over it, hand on the handle */
      if (tool === "hammer") this.drawHammer(c)
      else this.drawSaw(c)
      armStroke(c, 0.4, 0.2, g.x, g.y, 0.12, e.PAL.outline, e.PAL.limb)
    }
    c.restore()
  }

  /** the mallet, swung from his raised fist (unit space, pivot = grip) */
  private drawHammer(c: CanvasRenderingContext2D) {
    const e = this.e
    const g = this.toolGrip()
    c.save()
    c.translate(g.x, g.y)
    c.rotate(this.ang)
    const hl = 0.72
    c.lineCap = "round"
    c.lineJoin = "round"
    c.strokeStyle = e.PAL.woodDark
    c.lineWidth = 0.12
    c.beginPath()
    c.moveTo(0, 0.14)
    c.lineTo(0, -hl)
    c.stroke()
    c.strokeStyle = e.PAL.wood
    c.lineWidth = 0.075
    c.beginPath()
    c.moveTo(0, 0.12)
    c.lineTo(0, -hl + 0.04)
    c.stroke()
    c.beginPath()
    c.rect(-0.184, -hl - 0.13, 0.46, 0.26)
    c.fillStyle = e.PAL.steel
    c.fill()
    c.lineWidth = 0.05
    c.strokeStyle = e.PAL.steelEdge
    c.stroke()
    c.restore()
  }

  /** hand saw: D-grip around his hand, toothed blade biting down-forward
      into the edge; it rests in its kerf between strokes */
  private drawSaw(c: CanvasRenderingContext2D) {
    const e = this.e
    const g = this.toolGrip()
    c.save()
    c.translate(g.x, g.y)
    c.rotate(0.82)
    c.lineJoin = "round"
    /* blade with teeth along the working edge */
    c.beginPath()
    c.moveTo(0.12, -0.095)
    c.lineTo(0.98, -0.04)
    c.lineTo(0.94, 0.04)
    const teeth = 6
    for (let i = 0; i < teeth; i++) {
      const x0 = 0.94 - (i + 0.5) * (0.8 / teeth)
      const x1 = 0.94 - (i + 1) * (0.8 / teeth)
      c.lineTo(x0, 0.095)
      c.lineTo(x1, 0.05)
    }
    c.closePath()
    c.fillStyle = e.PAL.steel
    c.fill()
    c.lineWidth = 0.04
    c.strokeStyle = e.PAL.steelEdge
    c.stroke()
    /* D-grip, which the front-layer hand lands inside */
    c.beginPath()
    if (typeof c.roundRect === "function")
      c.roundRect(-0.17, -0.15, 0.32, 0.3, 0.11)
    else c.rect(-0.17, -0.15, 0.32, 0.3)
    c.lineWidth = 0.1
    c.strokeStyle = e.PAL.woodDark
    c.stroke()
    c.lineWidth = 0.055
    c.strokeStyle = e.PAL.wood
    c.stroke()
    c.restore()
  }

  /** the little two-handed drill: T-bar at chest height with a hand on
      each end (the front-layer arms land there), stout body, bit pumping
      into the surface — drill, hands and card judder together */
  private drawDrill(c: CanvasRenderingContext2D) {
    const e = this.e
    const running = this.phase === "drill"
    c.save()
    if (running) c.translate(0.55, -0.02 + this.jit)
    else {
      /* lugged along one-handed, tipped back */
      const g = this.toolGrip()
      c.translate(g.x, g.y)
      c.rotate(-0.3)
    }
    const rr = (x: number, y: number, w: number, h: number, r0: number) => {
      c.beginPath()
      if (typeof c.roundRect === "function") c.roundRect(x, y, w, h, r0)
      else c.rect(x, y, w, h)
    }
    c.lineJoin = "round"
    /* T-bar */
    rr(-0.27, -0.055, 0.54, 0.11, 0.05)
    c.fillStyle = e.PAL.steel
    c.fill()
    c.lineWidth = 0.04
    c.strokeStyle = e.PAL.steelEdge
    c.stroke()
    /* body */
    rr(-0.115, 0.055, 0.23, 0.42, 0.06)
    c.fillStyle = e.PAL.steel
    c.fill()
    c.lineWidth = 0.05
    c.stroke()
    /* vents */
    c.lineWidth = 0.028
    for (let i = 0; i < 2; i++) {
      c.beginPath()
      c.moveTo(-0.07, 0.16 + i * 0.09)
      c.lineTo(0.07, 0.16 + i * 0.09)
      c.stroke()
    }
    /* collar + bit down to the surface */
    rr(-0.06, 0.44, 0.12, 0.13, 0.03)
    c.fillStyle = e.PAL.steelEdge
    c.fill()
    c.beginPath()
    c.moveTo(-0.035, 0.55)
    c.lineTo(0.035, 0.55)
    c.lineTo(0, 0.74 + (running ? this.jit * 0.4 : 0))
    c.closePath()
    c.fillStyle = e.PAL.steel
    c.fill()
    c.lineWidth = 0.03
    c.stroke()
    c.restore()
  }

  pose(pose: PipPose, t: number) {
    const e = this.e
    const U = e.Sc
    pose.gazeX = e.face * 0.45
    pose.gazeY = 0.5
    if (!this.carrying()) pose.grip = this.toolGrip()
    if (this.phase === "strike" || this.phase === "raise")
      pose.tilt += e.face * (this.phase === "strike" ? 0.09 : 0.04)
    else if (this.phase === "saw") {
      /* lean into each stroke */
      pose.tilt += e.face * this.sawOff * 0.055
      pose.x += e.face * this.sawOff * U * 0.04
      pose.effort = Math.max(pose.effort, 0.25 + Math.abs(Math.cos(this.sawPh)) * 0.3)
    } else if (this.phase === "drill") {
      /* both hands on the bar; the pumping runs through him gently */
      pose.gripB = { x: 0.3, y: -0.02 + this.jit }
      pose.y += n1(t * 47) * U * 0.018
      pose.gazeX = e.face * 0.3
      pose.gazeY = 0.65
      pose.effort = Math.max(pose.effort, 0.6)
    } else if (this.phase === "scoot") {
      pose.gazeY = 0.15
      pose.tilt += e.face * 0.04
      pose.y -= Math.abs(Math.sin(this.scootPh)) * U * 0.05
    } else if (this.phase === "grab") {
      /* both hands down on the card's top edge */
      const k = clamp(this.phT / this.phDur, 0, 1)
      pose.sy *= 1 - 0.14 * Math.sin(Math.PI * k)
      pose.grip = { x: 0.32, y: 0.55 }
      pose.gripB = { x: 0.0, y: 0.58 }
      pose.gazeY = 0.8
      pose.effort = Math.max(pose.effort, 0.4)
    } else if (this.phase === "hoist") {
      pose.jet = Math.max(pose.jet, this.jetK)
      pose.sy *= 1 + 0.05 * this.jetK
      pose.gazeY = 0.6
      pose.effort = Math.max(pose.effort, 0.9)
    } else if (this.phase === "ascend") {
      pose.jet = Math.max(pose.jet, 1)
      pose.tilt -= e.face * 0.05 /* leaning back into the climb */
      pose.sy *= 1.04
      pose.gazeX = e.face * 0.15
      pose.gazeY = -0.35 /* eyes on the summit */
      pose.effort = Math.max(pose.effort, 0.85)
    } else if (this.phase === "chute") {
      pose.jet = Math.max(pose.jet, this.jetK)
      /* hands up on the parachute toggles (drawFront draws those arms) */
      pose.grip = { x: 0.44, y: -0.6 }
      pose.gripB = { x: -0.44, y: -0.6 }
      pose.tilt += this.cdx * 0.005
      pose.y += Math.sin(t * 2.3) * U * 0.015
      pose.gazeY = 0.3
      pose.effort = Math.max(pose.effort, 0.2)
    } else if (this.phase === "carry") {
      pose.jet = Math.max(pose.jet, 1)
      pose.y += Math.sin(t * 7) * U * 0.02
      pose.tilt += this.cdx * 0.004
      pose.gazeY = 0.35
      pose.effort = Math.max(pose.effort, 0.5)
    } else if (this.phase === "plonk") {
      pose.jet = Math.max(pose.jet, this.jetK)
      if (this.canopyK > 0.04) {
        /* hands stay on the toggles while the canopy folds away */
        pose.grip = { x: 0.44, y: -0.6 }
        pose.gripB = { x: -0.44, y: -0.6 }
      }
      pose.gazeY = 0.7
      pose.effort = Math.max(pose.effort, 0.5 * this.jetK)
    } else if (this.phase === "inspect") {
      pose.tilt += e.face * 0.04
    }
    pose.sy *= 1 - this.hitK * 0.1
    pose.sx *= 1 + this.hitK * 0.06
    pose.effort = Math.max(pose.effort, this.hitK * 0.6)
  }
}
