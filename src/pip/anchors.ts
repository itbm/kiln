import { clamp, dist } from "./math"
import type { Spot } from "./types"

/*
 * Spot discovery: where in the live DOM can Pip perch right now?
 *
 * Anchors are declared by the app with data-pip-spot attributes
 * ("ring" | "composer" | "header" | "menu" | "filters" | "sb-search" |
 * "sb-foot"); sheets, drawers and dialogs are found through their
 * data-slot attributes. Everything is re-queried on demand so Pip follows
 * layout changes, keyboards and animations without any wiring.
 */

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
  cx: number
  cy: number
}

export function rectOfEl(el: Element | null): Rect | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (!r.width && !r.height) return null
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
    cx: r.left + r.width / 2,
    cy: r.top + r.height / 2,
  }
}

const q = (sel: string) => document.querySelector(sel)

export const drawerEl = () =>
  q('[data-slot="drawer-content"][data-vaul-drawer-direction="left"]')

const bottomSheetEls = () =>
  Array.from(
    document.querySelectorAll(
      '[data-slot="drawer-content"][data-vaul-drawer-direction="bottom"]',
    ),
  )

export interface ZonePoint {
  x: number
  y: number
  s: number
  minX?: number
  maxX?: number
}

export interface AnchorEnv {
  W: number
  H: number
  px: number
  py: number
}

export function baseS(W: number, H: number): number {
  return clamp(Math.min(W, H) * 0.105, 28, 44)
}

/** Signature of the current overlay/view state — a change re-perches Pip. */
export function ovKey(): string {
  return (
    (drawerEl() ? "d" : "") +
    bottomSheetEls().length +
    (q('[data-slot="dialog-content"]') ? "x" : "") +
    (q('[data-pip-spot="ring"]') ? "r" : "") +
    "|" +
    window.location.pathname
  )
}

/** Resolve a zone spot to live coordinates (they track their element). */
export function zoneResolve(sp: Spot, env: AnchorEnv): ZonePoint | null {
  const S = baseS(env.W, env.H)
  if (sp.zone === "floor") {
    const c = rectOfEl(q('[data-pip-spot="composer"]'))
    if (!c) return null
    const minX = c.left + 26
    const maxX = c.right - 26
    return {
      x: clamp(c.left + (sp.fx ?? 0.5) * c.width, minX, maxX),
      y: c.top - S * 0.5,
      s: 0.8,
      minX,
      maxX,
    }
  }
  if (sp.zone === "bar") {
    const h = rectOfEl(q('[data-pip-spot="header"]'))
    if (!h) return null
    const minX = h.left + 60
    const maxX = h.right - 60
    return {
      x: clamp(h.left + 60 + (sp.fx ?? 0.5) * (h.width - 120), minX, maxX),
      y: h.bottom + S * 0.95,
      s: 0.82,
      minX,
      maxX,
    }
  }
  return null
}

/**
 * The artefact card currently streaming in — Pip's building site. Only
 * offered while no overlay covers the chat and the card's top edge sits
 * comfortably between header and composer (BuildAction uses a looser exit
 * band so he doesn't flicker on the boundary).
 */
export function buildSiteSpot(env: AnchorEnv): Spot | null {
  if (
    q('[data-slot="drawer-content"]') ||
    q('[data-slot="dialog-content"]') ||
    q('[data-pip-spot="ring"]')
  )
    return null
  const r = rectOfEl(q('[data-art-generating="true"]'))
  const comp = rectOfEl(q('[data-pip-spot="composer"]'))
  if (!r || !comp) return null
  const S = baseS(env.W, env.H)
  if (r.top < 70 || r.top > comp.top - S * 1.4) return null
  return {
    id: "art-site",
    ride: true,
    calm: true,
    w: 2,
    x: r.right - S * 0.7,
    y: r.top - S * 0.66 * 0.52,
    s: 0.66,
  }
}

/** All spots available in the current DOM/overlay state. */
export function elSpots(env: AnchorEnv): Spot[] {
  const S = baseS(env.W, env.H)
  const out: Spot[] = []
  const add = (
    id: string,
    el: Element | null,
    fn: (r: Rect) => { x: number; y: number; s: number },
    extra: Partial<Spot>,
  ) => {
    const r = rectOfEl(el)
    if (!r) return
    out.push({ id, ride: true, ...fn(r), ...extra })
  }
  const addZone = (zone: "floor" | "bar", w: number, extra?: Partial<Spot>) => {
    const sp: Spot = { id: zone + "Zone", zone, w, fx: Math.random(), ride: true, x: 0, y: 0, ...extra }
    const p = zoneResolve(sp, env)
    if (p) {
      sp.x = p.x
      sp.y = p.y
      sp.s = p.s
      out.push(sp)
    }
  }

  const drawer = drawerEl()
  const dialog = q('[data-slot="dialog-content"]')
  const sheets = bottomSheetEls()
  const ring = q('[data-pip-spot="ring"]')
  const composer = q('[data-pip-spot="composer"]')
  /* an open conversation (composer without the home ring): Pip stays out
     of the way, keeping to the ledge above the textarea */
  const calmChat = !!composer && !ring

  if (drawer) {
    add(
      "drawer-search",
      drawer.querySelector('[data-pip-spot="sb-search"]'),
      (r) => ({ x: r.right - S * 0.7, y: r.top - S * 0.55, s: 0.68 }),
      { w: 2, peek: true },
    )
    add(
      "drawer-foot",
      drawer.querySelector('[data-pip-spot="sb-foot"]'),
      (r) => ({ x: r.right - S * 0.95, y: r.top - S * 0.55, s: 0.85 }),
      { w: 3, home: true },
    )
  } else if (sheets.length) {
    const sheet = sheets[sheets.length - 1]
    const sheetR = rectOfEl(sheet)
    const tall = !!sheetR && sheetR.top < 80
    if (tall) {
      /* near-fullscreen sheet (artefact viewer, model picker): its header
         is packed with controls, so perch on the footer bar instead */
      add(
        "sheet",
        sheet.querySelector('[data-pip-spot="sheet-foot"]'),
        (r) => ({ x: r.right - S * 1.05, y: r.top - S * 0.5, s: 0.62 }),
        { w: 3, home: true, peek: true },
      )
    } else {
      add(
        "sheet",
        sheet,
        (r) => ({ x: r.right - S * 1.2, y: r.top - S * 0.42, s: 0.7 }),
        { w: 3, home: true, peek: true },
      )
      /* header peek only while the sheet leaves the header uncovered */
      add(
        "menu",
        q('[data-pip-spot="menu"]'),
        (r) => ({ x: r.right + S * 0.9, y: r.cy - S * 0.12, s: 0.55 }),
        { w: 1, peek: true },
      )
    }
  } else if (dialog) {
    add(
      "dialog",
      dialog,
      (r) => ({ x: r.right - S * 1.1, y: r.top - S * 0.5, s: 0.7 }),
      { w: 3, home: true },
    )
  } else if (ring) {
    /* the three home zones: red ring, floor line, pull-up bar */
    add(
      "ring",
      ring,
      (r) => ({ x: r.cx, y: r.top + r.height * 0.52, s: 1.18 }),
      { w: 4, home: true, zone: "ring" },
    )
    addZone("floor", 2)
    addZone("bar", 2)
  } else if (calmChat) {
    /* mid-conversation the messages are the show, so no acrobatics over
       them: a long rest at the ledge's right end, or a slow stroll along
       the line above the textarea (patrol.ts slows down on calm spots) */
    add(
      "composer",
      composer,
      (r) => ({ x: r.right - S * 0.8, y: r.top - S * 0.5, s: 0.8 }),
      { w: 3, home: true, calm: true },
    )
    addZone("floor", 2, { fx: 0.48 + Math.random() * 0.14, calm: true })
    /* while an artefact streams in, its card is his building site */
    const site = buildSiteSpot(env)
    if (site) out.push(site)
  } else {
    add(
      "menu",
      q('[data-pip-spot="menu"]'),
      (r) => ({ x: r.right + S * 0.9, y: r.cy - S * 0.12, s: 0.55 }),
      { w: 1, peek: true },
    )
    add(
      "filters",
      q('[data-pip-spot="filters"]'),
      (r) => ({ x: r.right - S * 0.65, y: r.cy - S * 0.25, s: 0.7 }),
      { w: 2 },
    )
    /* pages without a composer (Settings, Artefacts): hang off the header
       bar instead of hovering awkwardly over the content */
    const hdr = rectOfEl(q('[data-pip-spot="header"]'))
    if (hdr) addZone("bar", 2)
  }

  /* desktop sidebar (rendered outside any drawer) is fair game too —
     except mid-chat, where Pip keeps to the composer ledge */
  if (!drawer && !sheets.length && !dialog && !calmChat) {
    const foot = Array.from(
      document.querySelectorAll('[data-pip-spot="sb-foot"]'),
    ).find((el) => !el.closest('[data-slot="drawer-content"]'))
    add(
      "side-foot",
      foot ?? null,
      (r) => ({ x: r.right - S * 0.95, y: r.top - S * 0.55, s: 0.8 }),
      { w: 1, peek: true },
    )
  }

  return out.filter(
    (p) => p.y > 16 && p.y < env.H - 26 && p.x > 20 && p.x < env.W - 8,
  )
}

/** Weighted-random pick of the next perch, avoiding the current one. */
export function pickSpot(
  env: AnchorEnv,
  avoidId?: string,
  awayX?: number,
  awayY?: number,
): Spot {
  let cands = elSpots(env).filter(
    (p) => p.id !== avoidId && dist(p.x, p.y, env.px, env.py) > 90,
  )
  if (awayX !== undefined && awayY !== undefined) {
    const far = cands.filter((p) => dist(p.x, p.y, awayX, awayY) > 150)
    if (far.length) cands = far
  }
  if (!cands.length) {
    const all = elSpots(env)
    if (all.length) return all[Math.floor(Math.random() * all.length)]
    return { x: env.W * 0.5, y: env.H * 0.42, s: 1, ride: false, w: 1 }
  }
  let tot = 0
  for (const p of cands) tot += p.w || 1
  let r = Math.random() * tot
  for (const p of cands) {
    r -= p.w || 1
    if (r <= 0) return p
  }
  return cands[cands.length - 1]
}

/** Live position of a spot (zones and element spots track the DOM). */
export function resolveSpot(
  sp: Spot | null,
  env: AnchorEnv,
): ZonePoint | null {
  if (!sp) return null
  if (sp.zone === "floor" || sp.zone === "bar") return zoneResolve(sp, env)
  if (!sp.ride || !sp.id) return { x: sp.x, y: sp.y, s: sp.s ?? 1 }
  const fresh = elSpots(env).find((p) => p.id === sp.id)
  return fresh ? { x: fresh.x, y: fresh.y, s: fresh.s ?? 1 } : null
}
