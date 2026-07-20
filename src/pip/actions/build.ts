import { elSpots, rectOfEl } from "../anchors"
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
 * and "builds" it, cycling through his toolkit as the job drags on —
 * hammer strikes with spark showers, then a hand saw (wood chips fly),
 * then a pneumatic drill that judders the pair of them. The moment the
 * card finishes (its data-art-generating flag clears) he darts back down
 * to the composer ledge. He's sent up here by the engine's site check
 * (engine.tick) and DartAction hands over on landing.
 *
 * Past the 30-second mark the job is officially Taking Ages, so he lodges
 * a complaint with physics: grabs the top edge, fires up the jetpack and
 * airlifts the actual card — a real CSS transform on the DOM node — sways
 * it about, and plonks it back down. The transform is decorative and is
 * always undone: on completion, on any exit path (done/exit), and exit()
 * is invoked by whoever steals the mode (see engine.leaveMode).
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
    | "carry"
    | "plonk" = "raise"
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
  private sawPh = 0
  private sawOff = 0 /* stroke offset, -1..1 along the blade */
  private log: SiteLog = { t: 0, tool: 0, swapAt: 10, heaveAt: HEAVE_AT }
  /* the heave: offsets we are currently applying to the real card */
  private card: HTMLElement | null = null
  private cdx = 0
  private crot = 0
  private lift = 12
  private jetK = 0
  private thenGrab = false /* current scoot ends in a grab, not a bout */
  private cdxPrev = 0

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
    this.crot = rot
    if (this.card)
      this.card.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) rotate(${rot.toFixed(3)}deg)`
  }

  /** put the card back: the class transition is restored first, so whatever
      offset remains settles home smoothly (150ms) instead of snapping */
  private release() {
    const el = this.card
    this.card = null
    this.cdx = this.crot = 0
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
       straight back down to the ledge */
    if (
      !el ||
      !r ||
      !comp ||
      r.top < 54 ||
      r.top > comp.top - S * 0.9 ||
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
       card move as one) */
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
        else this.nextUp(r.width)
      }
    } else if (this.phase === "saw") {
      /* push, pull, push — chips fly while the blade is moving fast */
      this.sawPh += dt * 6.5
      this.sawOff = Math.sin(this.sawPh)
      const speed = Math.abs(Math.cos(this.sawPh))
      if (speed > 0.5 && Math.random() < dt * 5) {
        const hx = e.px + e.face * e.Sc * 1.05 /* where blade meets the edge */
        e.drops.spawn(hx, r.top - 1, true, Math.random() < 0.5 ? e.PAL.wood : e.PAL.woodMid, 12)
      }
      if (Math.random() < dt * 1.2) e.flareV = 1.6
      if (this.phT >= this.phDur) {
        this.sawOff = 0
        this.nextUp(r.width)
      }
    } else if (this.phase === "drill") {
      /* brrrrRRRT — the card judders with him (tiny, and let go smoothly) */
      this.grip(el)
      this.setCard(n1(t * 44) * 0.7, Math.abs(n1(t * 51)) * 0.5, 0)
      e.flareV = Math.max(e.flareV, 1.4)
      const hx = e.px + e.face * e.Sc * 0.85 /* the chisel tip */
      if (Math.random() < dt * 16) e.drops.spawn(hx, r.top - 1, true)
      if (Math.random() < dt * 3)
        e.drops.spawn(hx, r.top - 4, false, e.PAL.smoke, 40)
      if (this.phT >= this.phDur) {
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
        this.enter("carry", 3.2 + Math.random() * 1.4)
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
      if (this.phT >= this.phDur) this.enter("plonk", 0.55)
    } else {
      /* plonk: down she goes, with a little bounce on arrival */
      const k = clamp(this.phT / this.phDur, 0, 1)
      const b = easeOutBack(k) /* overshoots past 1 → a squash-down dip */
      this.jetK = 1 - k
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
  }

  /* ---------- the toolkit (drawn just beneath him, see draw order) ---------- */

  draw(t: number) {
    const e = this.e
    const c = e.g
    if (!c || e.mode !== "build") return
    if (this.carrying()) return /* tools are down while he heaves */
    const tool = TOOLS[this.log.tool]
    if (tool === "hammer") this.drawHammer(c)
    else if (tool === "saw") this.drawSaw(c)
    else this.drawDrill(c, t)
  }

  /** the mallet, pivoted at his forward hand (angled up-forward so it
      stays clear of his silhouette) */
  private drawHammer(c: CanvasRenderingContext2D) {
    const e = this.e
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

  /** hand saw: D-handle at arm's reach, toothed blade biting down-forward
      into the edge. Pivoted well forward of him — like the hammer, it
      draws *under* him, so it must stay clear of his silhouette — and
      between strokes it simply rests in its kerf, carpenter-style. */
  private drawSaw(c: CanvasRenderingContext2D) {
    const e = this.e
    const U = e.Sc
    const f = e.face < 0 ? -1 : 1
    const cutting = this.phase === "saw"
    c.save()
    c.translate(e.px + f * U * 0.72, e.py + U * 0.18)
    c.scale(f, 1)
    c.rotate(0.82)
    c.translate(cutting ? this.sawOff * U * 0.15 : 0, 0)
    c.lineJoin = "round"
    /* blade with teeth along the working edge */
    c.beginPath()
    c.moveTo(U * 0.16, -U * 0.1)
    c.lineTo(U * 1.06, -U * 0.045)
    c.lineTo(U * 1.02, U * 0.04)
    const teeth = 6
    for (let i = 0; i < teeth; i++) {
      const x0 = 1.02 - (i + 0.5) * (0.86 / teeth)
      const x1 = 1.02 - (i + 1) * (0.86 / teeth)
      c.lineTo(U * x0, U * 0.1)
      c.lineTo(U * x1, U * 0.055)
    }
    c.closePath()
    c.fillStyle = e.PAL.steel
    c.fill()
    c.lineWidth = U * 0.04
    c.strokeStyle = e.PAL.steelEdge
    c.stroke()
    /* D-grip */
    c.beginPath()
    if (typeof c.roundRect === "function")
      c.roundRect(-U * 0.18, -U * 0.15, U * 0.34, U * 0.3, U * 0.1)
    else c.rect(-U * 0.18, -U * 0.15, U * 0.34, U * 0.3)
    c.lineWidth = U * 0.1
    c.strokeStyle = e.PAL.woodDark
    c.stroke()
    c.lineWidth = U * 0.055
    c.strokeStyle = e.PAL.wood
    c.stroke()
    c.restore()
  }

  /** pneumatic drill: T-handle, stout steel body, chisel on the surface —
      the whole rig (and Pip, and the card) judders while it runs. Stood
      at arm's reach ahead of him so none of it hides behind his body
      (tools draw *under* him). */
  private drawDrill(c: CanvasRenderingContext2D, t: number) {
    const e = this.e
    const U = e.Sc
    const f = e.face < 0 ? -1 : 1
    const active = this.phase === "drill"
    const jy = active ? Math.abs(n1(t * 45)) * U * 0.05 : 0
    c.save()
    c.translate(e.px + f * U * 0.85, e.py + jy)
    c.scale(f, 1)
    if (this.phase === "scoot") c.rotate(-0.3) /* lugged along, tipped back */
    const rr = (x: number, y: number, w: number, h: number, r0: number) => {
      c.beginPath()
      if (typeof c.roundRect === "function") c.roundRect(x, y, w, h, r0)
      else c.rect(x, y, w, h)
    }
    c.lineJoin = "round"
    /* T-handle */
    rr(-U * 0.27, -U * 0.66, U * 0.54, U * 0.11, U * 0.05)
    c.fillStyle = e.PAL.steel
    c.fill()
    c.lineWidth = U * 0.04
    c.strokeStyle = e.PAL.steelEdge
    c.stroke()
    /* body */
    rr(-U * 0.115, -U * 0.56, U * 0.23, U * 0.62, U * 0.06)
    c.fillStyle = e.PAL.steel
    c.fill()
    c.lineWidth = U * 0.05
    c.stroke()
    /* vents */
    c.lineWidth = U * 0.028
    for (let i = 0; i < 2; i++) {
      c.beginPath()
      c.moveTo(-U * 0.07, -U * (0.38 - i * 0.09))
      c.lineTo(U * 0.07, -U * (0.38 - i * 0.09))
      c.stroke()
    }
    /* collar + chisel down to the surface */
    rr(-U * 0.06, U * 0.05, U * 0.12, U * 0.17, U * 0.03)
    c.fillStyle = e.PAL.steelEdge
    c.fill()
    c.beginPath()
    c.moveTo(-U * 0.035, U * 0.21)
    c.lineTo(U * 0.035, U * 0.21)
    c.lineTo(0, U * 0.52 + jy * 0.6)
    c.closePath()
    c.fillStyle = e.PAL.steel
    c.fill()
    c.lineWidth = U * 0.03
    c.stroke()
    c.restore()
  }

  pose(pose: PipPose, t: number) {
    const e = this.e
    const U = e.Sc
    pose.gazeX = e.face * 0.45
    pose.gazeY = 0.5
    if (this.phase === "strike" || this.phase === "raise")
      pose.tilt += e.face * (this.phase === "strike" ? 0.09 : 0.04)
    else if (this.phase === "saw") {
      /* lean into each stroke */
      pose.tilt += e.face * this.sawOff * 0.055
      pose.x += e.face * this.sawOff * U * 0.05
      pose.effort = Math.max(pose.effort, 0.25 + Math.abs(Math.cos(this.sawPh)) * 0.3)
    } else if (this.phase === "drill") {
      /* the judder owns him */
      pose.y += Math.abs(n1(t * 47)) * U * 0.045
      const buzz = Math.sin(t * 95)
      pose.sy *= 1 + buzz * 0.022
      pose.sx *= 1 - buzz * 0.014
      pose.gazeX = e.face * 0.3
      pose.gazeY = 0.65
      pose.effort = Math.max(pose.effort, 0.7)
    } else if (this.phase === "scoot") {
      pose.gazeY = 0.15
      pose.tilt += e.face * 0.04
      pose.y -= Math.abs(Math.sin(this.scootPh)) * U * 0.05
    } else if (this.phase === "grab") {
      const k = clamp(this.phT / this.phDur, 0, 1)
      pose.sy *= 1 - 0.14 * Math.sin(Math.PI * k)
      pose.gazeY = 0.8
      pose.effort = Math.max(pose.effort, 0.4)
    } else if (this.phase === "hoist") {
      pose.jet = Math.max(pose.jet, this.jetK)
      pose.sy *= 1 + 0.05 * this.jetK
      pose.gazeY = 0.6
      pose.effort = Math.max(pose.effort, 0.9)
    } else if (this.phase === "carry") {
      pose.jet = Math.max(pose.jet, 1)
      pose.y += Math.sin(t * 7) * U * 0.02
      pose.tilt += this.cdx * 0.004
      pose.gazeY = 0.35
      pose.effort = Math.max(pose.effort, 0.5)
    } else if (this.phase === "plonk") {
      pose.jet = Math.max(pose.jet, this.jetK)
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
