import type { Palette } from "./palette"

/** A perch/waypoint Pip can occupy. Element spots track their element live. */
export interface Spot {
  id?: string
  x: number
  y: number
  /** Pip's scale at this spot (1 = base size) */
  s?: number
  /** selection weight */
  w?: number
  /** re-resolve against the live element rect each frame */
  ride?: boolean
  /** peeking spots get shy body language */
  peek?: boolean
  /** home spots hold Pip longer */
  home?: boolean
  /** happy landing (wave + smiley eyes) */
  happy?: boolean
  /** dynamic zones: "ring" (axe stage), "floor" (composer ledge), "bar" (header) */
  zone?: "ring" | "floor" | "bar"
  /** fraction along the zone, for floor/bar placement */
  fx?: number
}

/** Everything drawPip needs for one frame. Actions mutate this via pose(). */
export interface PipPose {
  x: number
  y: number
  S: number
  tilt: number
  sx: number
  sy: number
  face: number
  shy: number
  hide: number
  giggle: number
  happy: boolean
  lid: number
  gazeX: number
  gazeY: number
  startled: boolean
  flare: number
  speed: number
  velX: number
  angry: number
  rage: number
  jet: number
  push: boolean
  pull: { grip: number } | null
  pullK: number
  effort: number
  walkPh: number | null
  windup: number
}

/**
 * A mode Pip can be in (exactly one at a time). One file per action under
 * src/pip/actions/ — add a new file + registry entry to teach Pip a trick.
 */
export interface PipAction {
  id: string
  /** advance one frame (only called while this action owns the mode) */
  update(dt: number, t: number): void
  /** scene drawing beneath Pip (e.g. the pull-up bar) */
  draw?(t: number): void
  /** contribute to the final pose just before Pip is drawn */
  pose?(pose: PipPose, t: number): void
  /** the mode is being left / interrupted */
  exit?(fast?: boolean): void
}

/**
 * A short performance Pip can put on while resting on his home ring —
 * axe throwing today; a Christmas-tree target or snowman juggling later.
 * Each ring act lives in its own file under src/pip/actions/.
 */
export interface RingAct {
  id: string
  /** selection weight against the other ring acts */
  weight: number
  /** begin the act (engine.act is already set to this id) */
  start(t: number): void
  /** advance; set engine.act = "" when done */
  update(dt: number, t: number): void
  /** act is being cancelled (fast = fade props out rather than pop) */
  cancel(fast: boolean): void
}

/** A prop in the scene (target board, thrown axe, …). */
export interface SceneProp {
  /** returns false once fully faded — engine removes it */
  step(dt: number, t: number): boolean
  draw(ctx: CanvasRenderingContext2D, pal: Palette, t: number): void
  /** start fading out */
  die(): void
}

/**
 * A cosmetic drawn on top of Pip in his local unit space (body ≈ 2 units
 * tall, origin at his middle; see draw/pip.ts). Register in
 * src/pip/accessories — e.g. a Santa hat for December.
 */
export interface PipAccessory {
  id: string
  /** called with the canvas already transformed into Pip's unit space */
  draw(
    ctx: CanvasRenderingContext2D,
    pose: PipPose,
    pal: Palette,
    t: number,
  ): void
}
