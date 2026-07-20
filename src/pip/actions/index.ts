import type { PipEngine } from "../engine"
import type { PipAction, RingAct } from "../types"
import { AxeThrowAct } from "./axe-throw"
import { BuildAction } from "./build"
import { DartAction } from "./dart"
import { DrawerHitAction } from "./drawer-hit"
import { FallAction } from "./fall"
import { JetCloseAction } from "./jetpack-close"
import { PatrolAction } from "./patrol"
import { PullupsAction } from "./pullups"
import { RestAction } from "./rest"

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
  return {
    rest,
    dart,
    patrol,
    pullups,
    fall,
    hit,
    jet,
    build,
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
    },
    ringActs: [new AxeThrowAct(e)],
  }
}
