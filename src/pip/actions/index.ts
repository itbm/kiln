import type { PipEngine } from "../engine"
import type { PipAction, RingAct } from "../types"
import { AxeThrowAct } from "./axe-throw"
import { BuildAction } from "./build"
import { DartAction } from "./dart"
import { DrawerHitAction } from "./drawer-hit"
import { FallAction } from "./fall"
import { JetCloseAction } from "./jetpack-close"
import { JuggleAct } from "./juggle"
import { PaintAction } from "./paint"
import { PatrolAction } from "./patrol"
import { PullupsAction } from "./pullups"
import { RestAction } from "./rest"
import { StumbleAction } from "./stumble"
import { SweepAction } from "./sweep"
import { TightropeAct } from "./tightrope"

/**
 * Pip's repertoire. One file per action — to teach him something new,
 * add a file in this folder and register it here:
 *  - a mode (owns him exclusively, like patrol or pull-ups): add to byMode
 *  - a ring act (a performance on the home ring, like axe throwing —
 *    or, come December, throwing axes at a Christmas tree): add to ringActs
 * Cosmetics (hats etc.) live in src/pip/accessories instead.
 */
export interface ActionSet {
  rest: RestAction
  dart: DartAction
  patrol: PatrolAction
  pullups: PullupsAction
  fall: FallAction
  hit: DrawerHitAction
  jet: JetCloseAction
  build: BuildAction
  paint: PaintAction
  sweep: SweepAction
  stumble: StumbleAction
  /** engine.mode → handler for that mode */
  byMode: Record<string, PipAction>
  ringActs: RingAct[]
}

export function createActions(e: PipEngine): ActionSet {
  const rest = new RestAction(e)
  const dart = new DartAction(e)
  const patrol = new PatrolAction(e)
  const pullups = new PullupsAction(e)
  const fall = new FallAction(e)
  const hit = new DrawerHitAction(e)
  const jet = new JetCloseAction(e)
  const build = new BuildAction(e)
  const paint = new PaintAction(e)
  const sweep = new SweepAction(e)
  const stumble = new StumbleAction(e)
  return {
    rest,
    dart,
    patrol,
    pullups,
    fall,
    hit,
    jet,
    build,
    paint,
    sweep,
    stumble,
    byMode: {
      rest,
      dart,
      walk: patrol,
      pullup: pullups,
      fall,
      hit,
      jet,
      push: jet,
      build,
      paint,
      sweep,
      stumble,
    },
    ringActs: [new AxeThrowAct(e), new JuggleAct(e), new TightropeAct(e)],
  }
}
