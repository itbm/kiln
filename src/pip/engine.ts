import {
  baseS,
  buildSiteSpot,
  drawerEl,
  elSpots,
  ovKey,
  pickSpot,
  rectOfEl,
  resolveSpot,
  type AnchorEnv,
} from "./anchors"
import { createActions, type ActionSet } from "./actions"
import { drawPip } from "./draw/pip"
import { Drops } from "./drops"
import { clamp, dist, n1 } from "./math"
import { buildPalette, type Palette } from "./palette"
import type { PipPose, SceneProp, Spot } from "./types"

/*
 * Pip's engine: the requestAnimationFrame loop, his shared "nervous system"
 * (shyness, anger, blinks, gaze, flare…) and the plumbing that hands each
 * frame to whichever action currently owns him. The behaviours themselves
 * live in src/pip/actions — one file per trick.
 */
export class PipEngine {
  cv: HTMLCanvasElement
  g: CanvasRenderingContext2D | null
  W = 0
  H = 0
  DPR = 1
  dark = false
  PAL: Palette
  reduceMotion: boolean
  isTouch: boolean

  /* position & motion */
  px = 190
  py = 300
  pvx = 0
  pvy = 0
  scale = 1.15
  speed = 0

  /* mode machine */
  mode = "rest"
  spot: Spot | null = null
  restT = 0
  restDur = 6
  face = 1
  faceT = 1

  /* envelopes & reactions */
  shy = 0
  hide = 0
  giggle = 0
  gigPulse = 0
  eepT = -1
  anger = 0
  angerHold = 0
  rage = 0
  /* mood set by the reply's hidden <emotion> tag (see bus.emote):
     "sad" | "worried" | "excited" | "thoughtful", "" = neutral */
  mood = ""
  moodK = 0
  moodT = 0
  sadK = 0
  tearK = 0
  excK = 0
  surpT = -1
  gazeX = 0
  gazeY = 0
  wanderX = 0
  wanderY = 0.1
  wanderNext = 0
  blinkT = -1
  blinkNext = 2.3
  antic = ""
  anticT = -1
  anticNext = 5
  flare = 1
  flareV = 0
  jetK = 0

  /* fields written by actions, read by the shared pose */
  tiltO = 0
  tiltExtra = 0
  windup = 0
  act = ""
  ringActNext = 2.5
  walkPh = 0
  walkPause = 0
  puK = 0
  puEffort = 0
  hitT = 0

  /* pointer */
  mouseX = -9999
  mouseY = -9999
  lastMove = 0
  nearSince = -1
  nearD = Infinity
  near = false
  veryNear = false

  drops = new Drops()
  props: SceneProp[] = []
  actions: ActionSet

  private lastOv = ""
  private ovCheckAt = 0
  private drawerWatchUntil = 0
  private raf = 0
  private last = 0
  private errors = 0
  private cleanup: (() => void)[] = []

  constructor(cv: HTMLCanvasElement) {
    this.cv = cv
    this.g = cv.getContext("2d")
    this.reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches
    this.isTouch = matchMedia("(pointer: coarse)").matches
    this.dark = document.documentElement.classList.contains("dark")
    this.PAL = buildPalette(this.dark)
    this.actions = createActions(this)
  }

  get S0(): number {
    return baseS(this.W, this.H)
  }
  get Sc(): number {
    return this.scale * this.S0
  }
  get env(): AnchorEnv {
    return { W: this.W, H: this.H, px: this.px, py: this.py }
  }

  /* ---------- lifecycle ---------- */

  start() {
    if (!this.g) return
    this.resize()
    /* iOS settles innerHeight/visualViewport at odd moments while the
       keyboard animates in — re-measure on every signal, and once more
       after the dust settles */
    let settle = 0
    const onResize = () => {
      this.resize()
      clearTimeout(settle)
      settle = window.setTimeout(() => this.resize(), 400)
    }
    window.addEventListener("resize", onResize)
    window.visualViewport?.addEventListener("resize", onResize)
    window.visualViewport?.addEventListener("scroll", onResize)
    this.cleanup.push(() => {
      clearTimeout(settle)
      window.removeEventListener("resize", onResize)
      window.visualViewport?.removeEventListener("resize", onResize)
      window.visualViewport?.removeEventListener("scroll", onResize)
    })

    /* follow dark/light switches from the theme system */
    const mo = new MutationObserver(() => {
      const d = document.documentElement.classList.contains("dark")
      if (d !== this.dark) {
        this.dark = d
        this.PAL = buildPalette(d)
        if (this.reduceMotion) this.renderOnce()
      }
    })
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    this.cleanup.push(() => mo.disconnect())

    const onMove = (e: PointerEvent) => {
      this.mouseX = e.clientX
      this.mouseY = e.clientY
      this.lastMove = performance.now() / 1000
    }
    const onLeave = () => {
      this.mouseX = -9999
      this.mouseY = -9999
    }
    const onDown = (e: PointerEvent) => this.pointerDown(e)
    window.addEventListener("pointermove", onMove, { passive: true })
    document.addEventListener("pointerleave", onLeave)
    window.addEventListener("pointerdown", onDown, { passive: true })
    this.cleanup.push(() => {
      window.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerleave", onLeave)
      window.removeEventListener("pointerdown", onDown)
    })

    /* settle onto a home spot (or any perch on pages without one) */
    const spots = elSpots(this.env)
    const home = spots.find((p) => p.home) ?? spots[0]
    this.spot = home ?? {
      x: (this.W || 380) * 0.5,
      y: (this.H || 600) * 0.42,
      s: 1.1,
      ride: false,
    }
    const hp = resolveSpot(this.spot, this.env)
    if (hp) {
      this.px = hp.x
      this.py = hp.y
      this.scale = hp.s || 1
    }
    this.restDur = 5
    if (this.spot.zone === "floor") this.actions.patrol.begin()
    else if (this.spot.zone === "bar") this.actions.pullups.begin()
    this.lastOv = ovKey()

    if (this.reduceMotion) {
      this.renderOnce()
      return
    }
    this.last = performance.now()
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick)
      try {
        this.tick(now)
        this.errors = 0
      } catch (err) {
        // Pip is decorative — he must never take the app down with him
        if (++this.errors >= 3) {
          cancelAnimationFrame(this.raf)
          try {
            this.leaveMode(true) /* hand back anything he was holding */
          } catch {
            /* already retiring */
          }
          console.warn("Pip retired after repeated errors:", err)
        }
      }
    }
    this.raf = requestAnimationFrame(tick)
  }

  destroy() {
    try {
      this.leaveMode(true)
    } catch {
      /* teardown must not throw */
    }
    cancelAnimationFrame(this.raf)
    for (const fn of this.cleanup) fn()
    this.cleanup = []
  }

  private resize() {
    const W = window.innerWidth
    const H = window.innerHeight
    const DPR = Math.min(window.devicePixelRatio || 1, 2)
    if (W === this.W && H === this.H && DPR === this.DPR) return
    this.W = W
    this.H = H
    this.DPR = DPR
    this.cv.width = Math.max(1, Math.round(W * DPR))
    this.cv.height = Math.max(1, Math.round(H * DPR))
    /* size the CSS box explicitly from the same numbers as the bitmap:
       with the iOS keyboard up, "100%" of the fixed containing block and
       window.innerHeight can disagree, and any mismatch renders Pip
       stretched and offset — sometimes down behind the keyboard */
    this.cv.style.width = `${W}px`
    this.cv.style.height = `${H}px`
    if (this.reduceMotion) this.renderOnce()
  }

  /* ---------- events from the app (see bus.ts) ---------- */

  notify() {
    if (this.reduceMotion) {
      this.renderOnce()
      return
    }
    if (this.busy() || this.mode === "fall") return
    const k = ovKey()
    if (k !== this.lastOv) {
      this.lastOv = k
      this.startDart(pickSpot(this.env, this.spot?.id))
      return
    }
    if (!resolveSpot(this.spot, this.env))
      this.startDart(pickSpot(this.env, this.spot?.id))
  }

  celebrate() {
    if (this.reduceMotion || this.busy()) return
    const S = this.S0
    const r = rectOfEl(document.querySelector('[data-pip-spot="composer"]'))
    const calm = !document.querySelector('[data-pip-spot="ring"]')
    /* a gloomy reply gets a quiet landing, not a wave and confetti */
    const glum = this.sadK > 0.4
    if (r)
      this.startDart({
        id: "composer",
        ride: true,
        s: calm ? 0.8 : 0.9,
        happy: !glum,
        home: calm,
        calm,
        w: 1,
        x: r.right - S * 0.8,
        y: r.top - S * 0.5,
      })
    this.flareV = glum ? 1.4 : 3
    const sparks = glum ? 0 : 6
    for (let i = 0; i < sparks; i++) this.drops.spawn(this.px, this.py, true)
  }

  flareUp() {
    this.flareV = 3
  }

  /**
   * The reply's hidden <emotion> tag (see src/lib/emotions.ts). Quick
   * feelings (happy, surprised…) are pulses on the existing envelopes;
   * lingering ones (sad, worried, excited, thoughtful) set a mood that
   * colours everything until it fades or the next reply replaces it.
   */
  emote(kind: string) {
    if (this.reduceMotion) {
      this.renderOnce()
      return
    }
    this.mood = ""
    this.moodK = 0
    this.moodT = 0
    const resting = this.mode === "rest" && this.act === ""
    switch (kind) {
      case "happy":
        this.gigPulse = Math.max(this.gigPulse, 1.6)
        this.flareV = 2.6
        break
      case "excited":
        this.mood = "excited"
        this.moodK = 1
        this.moodT = 22
        this.gigPulse = Math.max(this.gigPulse, 2)
        this.flareV = 3.4
        if (resting) {
          this.antic = "hop"
          this.anticT = 0
        }
        for (let i = 0; i < 8; i++)
          this.drops.spawn(this.px, this.py - this.Sc * 0.6, true)
        break
      case "thoughtful":
        this.mood = "thoughtful"
        this.moodK = 1
        this.moodT = 25
        break
      case "worried":
        this.mood = "worried"
        this.moodK = 1
        this.moodT = 30
        break
      case "sad":
        this.mood = "sad"
        this.moodK = 0.62
        this.moodT = 45
        break
      case "crying":
        this.mood = "sad"
        this.moodK = 1
        this.moodT = 45
        break
      case "surprised":
        this.surpT = 0
        this.flareV = 3
        if (resting) {
          this.antic = "hop"
          this.anticT = 0
        }
        break
      case "angry":
        this.anger = Math.max(this.anger, 0.8)
        this.angerHold = 3
        this.flareV = 3
        break
      default:
        /* neutral (or an unknown mood) gently clears the slate */
        break
    }
  }

  drawerOpening() {
    this.actions.jet.cancel()
    if (this.reduceMotion) return
    /* watch the sliding edge — if it reaches Pip, he gets clobbered */
    this.drawerWatchUntil = performance.now() / 1000 + 1.4
  }

  drawerClosing() {
    if (this.reduceMotion) return
    this.drawerWatchUntil = 0
    this.actions.jet.beginClose()
  }

  /* ---------- helpers used by actions ---------- */

  busy(): boolean {
    return this.mode === "jet" || this.mode === "push" || this.mode === "hit"
  }

  /** let the current mode's action clean up after itself (build putting the
      artefact card back, say) before another action takes the mode over */
  leaveMode(fast?: boolean) {
    this.actions.byMode[this.mode]?.exit?.(fast)
  }

  startDart(target: Spot | null) {
    this.actions.dart.begin(target)
  }

  pickNext(awayX?: number, awayY?: number): Spot {
    return pickSpot(this.env, this.spot?.id, awayX, awayY)
  }

  enterRest() {
    this.mode = "rest"
    this.restT = 0
    const sp = this.spot
    this.restDur = sp?.home
      ? sp.calm
        ? /* chat ledge: linger at the right end, mostly sitting still */
          9 + Math.random() * 6
        : 6 + Math.random() * 3
      : sp?.peek
        ? 2.5 + Math.random() * 2
        : 3.5 + Math.random() * 3
    this.anticNext = 1.6 + Math.random() * 3
    if (sp?.zone === "ring") this.ringActNext = 1 + Math.random() * 1.6
  }

  /** cancel any running ring act (fast = let props fade out) */
  clearAct(fast?: boolean) {
    if (this.act) {
      const act = this.actions.ringActs.find((a) => a.id === this.act)
      act?.cancel(!!fast)
    }
    if (!fast) this.props = []
    this.act = ""
    this.windup = 0
  }

  startRingAct(t: number) {
    const acts = this.actions.ringActs
    if (!acts.length) return
    let tot = 0
    for (const a of acts) tot += a.weight
    let r = Math.random() * tot
    let chosen = acts[acts.length - 1]
    for (const a of acts) {
      r -= a.weight
      if (r <= 0) {
        chosen = a
        break
      }
    }
    this.act = chosen.id
    chosen.start(t)
  }

  /* ---------- pointer ---------- */

  private pointerDown(e: PointerEvent) {
    if (this.reduceMotion || this.busy()) return
    const x = e.clientX
    const y = e.clientY
    if (dist(x, y, this.px, this.py) < this.scale * this.S0 * 1.7) {
      if (this.mode === "pullup") {
        this.eepT = 0
        this.actions.fall.begin()
        for (let i = 0; i < 8; i++) this.drops.spawn(this.px, this.py, true)
        return
      }
      this.eepT = 0
      this.hide = 1
      if (this.mode === "walk") {
        this.mode = "rest"
        this.restT = 0
        this.restDur = 2
      }
      for (let j = 0; j < 10; j++) this.drops.spawn(this.px, this.py, true)
    }
  }

  /* ---------- static frame for prefers-reduced-motion ---------- */

  renderOnce() {
    const c = this.g
    if (!c) return
    c.setTransform(this.DPR, 0, 0, this.DPR, 0, 0)
    c.clearRect(0, 0, this.W, this.H)
    const r =
      rectOfEl(document.querySelector('[data-pip-spot="ring"]')) ??
      rectOfEl(document.querySelector('[data-pip-spot="composer"]'))
    const x = r ? r.cx : this.W * 0.5
    const y = r ? r.top + r.height * 0.52 : this.H * 0.4
    drawPip(c, this.PAL, this.dark, 1.7, {
      x,
      y,
      S: this.S0 * 1.18,
      tilt: 0,
      sx: 1,
      sy: 1,
      face: 1,
      shy: 0.2,
      hide: 0,
      giggle: 0,
      happy: false,
      lid: 1,
      gazeX: 0.2,
      gazeY: 0.1,
      startled: false,
      flare: 1,
      speed: 0,
      velX: 0,
      angry: 0,
      rage: 0,
      sad: 0,
      tears: 0,
      jet: 0,
      push: false,
      pull: null,
      pullK: 0,
      effort: 0,
      walkPh: null,
      windup: 0,
      grip: null,
      gripB: null,
    })
  }

  /* ---------- the loop ---------- */

  private tick(now: number) {
    const c = this.g
    if (!c) return
    const dt = Math.min((now - this.last) / 1000, 0.05)
    this.last = now
    const t = now / 1000
    const ox = this.px
    const oy = this.py
    const Sc = this.Sc

    this.nearD = dist(this.mouseX, this.mouseY, this.px, this.py)
    this.near = this.nearD < this.scale * this.S0 * 2.5
    this.veryNear = this.nearD < this.scale * this.S0 * 1.6
    this.tiltExtra = 0

    /* overlay / route changes re-perch him (throttled DOM check) */
    if (t > this.ovCheckAt) {
      this.ovCheckAt = t + 0.15
      if (!this.busy() && this.mode !== "fall") {
        const k = ovKey()
        if (k !== this.lastOv) {
          this.lastOv = k
          this.startDart(pickSpot(this.env, this.spot?.id))
        } else if (this.mode !== "build" && this.spot?.id !== "art-site") {
          /* a streaming artefact card calls him up to play builder */
          const site = buildSiteSpot(this.env)
          if (site) this.startDart(site)
        }
      }
    }

    /* drawer collision watch (armed while the drawer slides open) */
    if (this.drawerWatchUntil > 0) {
      if (t > this.drawerWatchUntil) this.drawerWatchUntil = 0
      else if (this.mode !== "hit") {
        const r = rectOfEl(drawerEl())
        if (r && r.right >= this.px - Sc * 0.4 && this.px < r.right + Sc) {
          this.drawerWatchUntil = 0
          this.actions.hit.begin()
        }
      }
    }

    /* anger cools slowly */
    if (this.angerHold > 0) this.angerHold -= dt
    else this.anger += (0 - this.anger) * (1 - Math.pow(0.3, dt))
    this.rage = this.mode === "rest" ? this.anger : this.anger * 0.25
    if (this.anger > 0.5 && Math.random() < dt * 4)
      this.drops.spawn(
        this.px + (Math.random() - 0.5) * Sc,
        this.py - Sc * 1.15,
        false,
        this.PAL.smoke,
        55,
      )

    /* moods (from the reply's <emotion> tag) linger, then fade */
    if (this.moodT > 0) {
      this.moodT -= dt
      if (this.moodT <= 0) {
        this.mood = ""
        this.moodK = 0
      }
    }
    const sadTgt =
      this.mood === "sad" ? this.moodK : this.mood === "worried" ? 0.32 : 0
    this.sadK += (sadTgt - this.sadK) * (1 - Math.pow(0.05, dt))
    const tearTgt = this.mood === "sad" && this.moodK > 0.85 ? 1 : 0
    this.tearK +=
      (tearTgt - this.tearK) * (1 - Math.pow(tearTgt ? 0.01 : 0.08, dt))
    this.excK +=
      ((this.mood === "excited" ? this.moodK : 0) - this.excK) *
      (1 - Math.pow(0.02, dt))
    if (this.surpT >= 0) {
      this.surpT += dt
      if (this.surpT > 1.1) this.surpT = -1
    }
    /* crying: tears dribble from the eyes */
    if (this.tearK > 0.3 && Math.random() < dt * (1 + this.tearK * 2.2)) {
      const side = Math.random() < 0.5 ? -1 : 1
      this.drops.tear(
        this.px + side * Sc * 0.16,
        this.py + Sc * 0.1,
        this.PAL.sweat,
      )
    }

    /* ============ mode machine (see src/pip/actions) ============ */
    const action = this.actions.byMode[this.mode] ?? this.actions.byMode.rest
    action.update(dt, t)

    /* ============ shared systems ============ */
    this.pvx = (this.px - ox) / Math.max(dt, 0.001)
    this.pvy = (this.py - oy) / Math.max(dt, 0.001)
    this.speed = Math.sqrt(this.pvx * this.pvx + this.pvy * this.pvy)
    const busyMode = this.busy()

    if (this.eepT >= 0) {
      this.eepT += dt
      if (this.eepT > 1.5) {
        this.eepT = -1
        if (this.mode === "rest")
          this.startDart(this.pickNext(this.mouseX, this.mouseY))
      }
    }
    const hideTgt =
      this.eepT >= 0 && !busyMode && this.mode !== "pullup"
        ? this.eepT < 0.9
          ? 1
          : this.eepT < 1.15
            ? 0.5
            : 0.9
        : 0
    this.hide += (hideTgt - this.hide) * (1 - Math.pow(0.001, dt))

    let shyTgt = busyMode
      ? 0
      : this.veryNear
        ? 1
        : this.near
          ? 0.75
          : this.spot?.peek
            ? 0.6
            : 0.1
    if (this.mode === "dart") shyTgt = Math.max(shyTgt, 0.3)
    if (this.mode === "pullup") shyTgt *= 0.5
    if (this.anger > 0.4) shyTgt = 0
    this.shy += (shyTgt - this.shy) * (1 - Math.pow(0.02, dt))
    this.gigPulse = Math.max(0, this.gigPulse - dt)
    const gigTgt =
      (this.antic === "giggle" ||
      this.gigPulse > 0 ||
      (this.near && !this.veryNear && !busyMode && this.anger < 0.3)
        ? 1
        : 0) * (1 - this.sadK * 0.85) /* no giggling through the gloom */
    this.giggle += (gigTgt - this.giggle) * (1 - Math.pow(0.008, dt))

    if (
      this.mode === "rest" &&
      this.eepT < 0 &&
      !this.near &&
      this.act === "" &&
      this.spot?.zone !== "ring"
    ) {
      this.anticNext -= dt
      if (this.anticT < 0 && this.anticNext <= 0) {
        this.antic =
          this.sadK > 0.45
            ? /* blue Pip doesn't hop about — he sighs and stares */
              Math.random() < 0.65
              ? "sigh"
              : "look"
            : ["giggle", "look", "flare", "hop"][Math.floor(Math.random() * 4)]
        this.anticT = 0
        this.anticNext = 4 + Math.random() * 4
        if (this.antic === "flare") this.flareV = 3.2
        if (this.antic === "sigh") this.flareV = -1.6 /* the flame slumps */
      }
    }
    if (this.anticT >= 0) {
      const wasT = this.anticT
      this.anticT += dt
      if (this.antic === "sigh" && wasT < 0.55 && this.anticT >= 0.55)
        this.drops.spawn(this.px, this.py - Sc * 1.2, false, this.PAL.smoke, 32)
      if (
        this.anticT >
        (this.antic === "giggle" ? 1.3 : this.antic === "sigh" ? 1.5 : 0.9)
      ) {
        this.anticT = -1
        this.antic = ""
      }
    }

    /* sadness banks the flame down; excitement stokes it */
    const flareBase = 1 - this.sadK * 0.24 + this.excK * 0.1
    this.flareV += (flareBase - this.flare) * 10 * dt - this.flareV * 4 * dt
    this.flare += this.flareV * dt
    const jetTgt = this.mode === "jet" || this.mode === "push" ? 1 : 0
    this.jetK +=
      (jetTgt - this.jetK) * (1 - Math.pow(jetTgt ? 0.0001 : 0.02, dt))

    const idle = t - this.lastMove > 3.2 || this.mouseX < -999
    const lookWander = idle || this.antic === "look"
    if (lookWander) {
      this.wanderNext -= dt
      if (this.wanderNext <= 0) {
        this.wanderX = (Math.random() - 0.5) * 1.6
        this.wanderY = (Math.random() - 0.45) * 0.9
        this.wanderNext = 1 + Math.random() * 1.8
      }
    }
    let lx = lookWander
      ? this.wanderX
      : clamp((this.mouseX - this.px) / 240, -1, 1)
    let ly = lookWander
      ? this.wanderY
      : clamp((this.mouseY - this.py) / 240, -1, 1)
    if (this.anger > 0.4 && this.mode === "rest") {
      lx = -0.9 * this.face
      ly = 0.05
    }
    if (this.mode !== "push" && this.mode !== "build") {
      if (this.mood === "thoughtful") {
        /* eyes drift up and aside, pondering */
        lx = lx * 0.35 + this.face * 0.4
        ly = Math.min(ly, -0.5)
      }
      if (this.sadK > 0.05) {
        /* downcast */
        lx *= 1 - this.sadK * 0.55
        ly += this.sadK * 0.6
      }
    }
    if (this.mode === "push") {
      lx = 0.8
      ly = 0.1
    }
    const avert = this.shy * 0.9 * (this.eepT >= 0 ? 0 : 1)
    this.gazeX +=
      (lx * (1 - 1.8 * avert) - this.gazeX) * (1 - Math.pow(0.004, dt))
    this.gazeY +=
      (ly * (1 - avert) + avert * 0.6 - this.gazeY) *
      (1 - Math.pow(0.004, dt))

    this.blinkNext -= dt
    let lid = 1
    if (this.blinkNext <= 0 && this.blinkT < 0) {
      this.blinkT = 0
      this.blinkNext =
        (2 + Math.random() * 3) * (this.mood === "thoughtful" ? 1.5 : 1)
    }
    if (this.blinkT >= 0) {
      this.blinkT += dt
      const bk = this.blinkT / 0.15
      lid = bk < 1 ? Math.max(0.06, Math.abs(1 - 2 * Math.min(bk, 1))) : 1
      if (this.blinkT > 0.15) {
        this.blinkT = -1
        lid = 1
      }
    }
    lid *= (1 - Math.min(0.35, this.speed * 0.0005)) * (1 - this.hide * 0.2)

    let bob = 0
    if (this.mode === "rest")
      bob =
        Math.sin(t * 2.1) * 0.028 * (1 - this.sadK * 0.5) +
        this.excK * Math.abs(Math.sin(t * 4.4)) * 0.05 +
        (this.antic === "hop" && this.anticT >= 0
          ? Math.sin(clamp(this.anticT / 0.5, 0, 1) * 3.1416) * 0.16
          : 0)
    if (this.mode === "walk") bob = Math.abs(Math.sin(this.walkPh)) * 0.045
    const sq = Math.min(0.24, this.speed * 0.00075)
    const angW = this.speed > 1 ? Math.abs(this.pvx) / this.speed : 1
    let sx = 1 + sq * angW - sq * (1 - angW) * 0.55
    let sy = 1 - sq * angW * 0.55 + sq * (1 - angW)
    sy *= 1 + Math.sin(t * 2.6) * 0.015
    if (this.mode === "pullup") {
      sy *= 1 + this.puK * 0.06
      sx *= 1 - this.puK * 0.04
    }
    /* sniffly shudder while crying */
    if (this.tearK > 0.4) sy *= 1 + n1(t * 21) * 0.012 * this.tearK
    const shrink =
      (1 - this.shy * 0.08 - this.hide * 0.05 - this.sadK * 0.05) *
      (1 + this.anger * 0.05)
    this.face += (this.faceT - this.face) * (1 - Math.pow(0.0008, dt))
    if (this.mode !== "hit") this.tiltO *= 1 - Math.min(1, dt * 3)
    let tilt =
      clamp(-this.pvx * 0.0005, -0.3, 0.3) +
      n1(t * 1.2) * 0.02 +
      this.tiltO +
      this.tiltExtra
    if (this.jetK > 0.2) tilt += this.face * 0.1 * this.jetK

    this.drops.step(dt, t)
    if (this.mode === "rest" && Math.random() < dt * 2.2)
      this.drops.spawn(this.px, this.py - Sc * 1.1, false)

    this.props = this.props.filter((p) => p.step(dt, t))

    /* ============ render ============ */
    c.setTransform(this.DPR, 0, 0, this.DPR, 0, 0)
    c.clearRect(0, 0, this.W, this.H)
    this.drops.draw(c, this.PAL)
    for (const p of this.props) p.draw(c, this.PAL, t)
    action.draw?.(t)

    const pose: PipPose = {
      x: this.px,
      y: this.py - bob * Sc,
      S: Sc * shrink,
      tilt,
      sx,
      sy,
      face: clamp(this.face, -1, 1) || 0.01,
      velX: this.pvx,
      speed: this.speed,
      flare: clamp(this.flare, 0.6, 1.5),
      shy: this.shy,
      hide: this.hide,
      giggle: this.giggle,
      happy: !!this.spot?.happy,
      lid,
      gazeX: this.gazeX,
      gazeY: this.gazeY,
      startled:
        ((this.shy > 0.85 && this.giggle < 0.4) ||
          this.eepT >= 0 ||
          (this.surpT >= 0 && this.surpT < 0.75) ||
          (this.mode === "hit" && this.hitT < 0.4)) &&
        this.anger < 0.5,
      angry: this.anger,
      rage: this.rage,
      sad: this.sadK,
      tears: this.tearK,
      jet: this.jetK,
      push: this.mode === "push",
      pull: null,
      pullK: this.puK,
      effort: this.mode === "pullup" ? this.puEffort : 0,
      walkPh: this.mode === "walk" && this.walkPause <= 0 ? this.walkPh : null,
      windup: this.windup,
      grip: null,
      gripB: null,
    }
    action.pose?.(pose, t)
    drawPip(c, this.PAL, this.dark, t, pose)
    /* front layer: things he holds draw over him (see PipAction.drawFront) */
    action.drawFront?.(t, pose)
  }
}
