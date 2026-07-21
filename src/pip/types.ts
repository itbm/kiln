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
  /** calm spots (open chat): slow strolls, gentle hops, long right-end rests */
  calm?: boolean
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
  /** sadness envelope 0..1 — droopy brows, downturned mouth, heavy lids */
  sad: number
  /** crying envelope 0..1 — welling eyes (the engine adds falling tears) */
  tears: number
  jet: number
  push: boolean
  pull: { grip: number } | null
  pullK: number
  effort: number
  walkPh: number | null
  windup: number
  /** forward hand is gripping at this unit-space point: drawPip skips that
      arm and the action's front layer draws it OVER the held tool instead */
  grip: { x: number; y: number } | null
  /** same for the back hand — two-handed grips (heaving the card edge) */
  gripB: { x: number; y: number } | null
}

/**
 * A mode Pip can be in (exactly one at a time). One file per action under
 * src/pip/actions/ — add a new file + registry entry to teach Pip a trick.
 */
export interface PipAction {
  id: string
  /** advance one frame (only called while this action owns the mode) */
  update(dt: number, t: number): void
  /** back layer: scene drawing beneath Pip (pull-up bar, free-standing kit) */
  draw?(t: number): void
  /** contribute to the final pose just before Pip is drawn */
  pose?(pose: PipPose, t: number): void
  /**
   * front layer: drawn after Pip, over his body — anything he holds
   * (tools in his hands). Receives the final pose so held items can be
   * drawn in his transformed unit space, anchored to pose.grip/gripB.
   */
  drawFront?(t: number, pose: PipPose): void
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
