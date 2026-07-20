import { accessories } from "../accessories"
import { clamp, lerp, n1 } from "../math"
import { mixHex, type Palette } from "../palette"
import type { PipPose } from "../types"

/*
 * Pip himself. Everything here draws in his local unit space: origin at his
 * middle, y down, body roughly 2 units tall before scaling by pose.S.
 * Ported from the approved app mockup (v2) — keep the numbers as they are;
 * they are the character.
 */

function bodyPath(
  ctx: CanvasRenderingContext2D,
  t: number,
  sway: number,
  flare: number,
) {
  const rim = -0.24
  const vX = [-0.5, -0.28, -0.06, 0.16, 0.34, 0.5]
  const Hh = [0.55, 0.95, 1.18, 0.78, 0.46]
  const LN = [-0.13, -0.05, 0.04, 0.11, 0.17]
  ctx.beginPath()
  ctx.moveTo(0.5, rim)
  const w1 = n1(t * 1.4) * 0.02
  const w2 = n1(t * 1.4 + 3) * 0.02
  ctx.bezierCurveTo(0.585 + w1, 0.12, 0.5, 0.44, 0.28, 0.585)
  ctx.bezierCurveTo(0.14, 0.675, -0.14, 0.675, -0.28, 0.585)
  ctx.bezierCurveTo(-0.5, 0.44, -0.585 + w2, 0.12, -0.5, rim)
  for (let i = 0; i < 5; i++) {
    const v1x = vX[i]
    const v2x = vX[i + 1]
    const v1y = i === 0 ? rim : rim - 0.02 + n1(t * 2.1 + i) * 0.02
    const v2y = i === 4 ? rim : rim - 0.02 + n1(t * 2.1 + i + 1) * 0.02
    const h = Hh[i] * flare * (1 + 0.16 * n1(t * 2.4 + i * 1.7))
    const tx =
      (v1x + v2x) / 2 + LN[i] * 0.5 + sway * h * 0.55 + 0.06 * n1(t * 3.5 + i * 2.6)
    const ty = rim - h
    ctx.bezierCurveTo(
      v1x + (tx - v1x) * 0.12,
      v1y - h * 0.14,
      tx + (v1x - tx) * 0.3,
      ty + h * 0.4,
      tx,
      ty,
    )
    ctx.bezierCurveTo(
      tx + (v2x - tx) * 0.3,
      ty + h * 0.4,
      v2x + (tx - v2x) * 0.12,
      v2y - h * 0.14,
      v2x,
      v2y,
    )
  }
  ctx.closePath()
}

function innerPath(
  ctx: CanvasRenderingContext2D,
  t: number,
  sway: number,
  flare: number,
) {
  const rim = -0.03
  const off = 0.06
  const vX = [-0.3, -0.09, 0.13, 0.3]
  const Hh = [0.5, 0.8, 0.44]
  const LN = [-0.07, 0.03, 0.11]
  ctx.beginPath()
  ctx.moveTo(0.3, rim + off)
  ctx.bezierCurveTo(0.37, 0.2 + off, 0.28, 0.4 + off, 0.0, 0.44 + off)
  ctx.bezierCurveTo(-0.28, 0.4 + off, -0.37, 0.2 + off, -0.3, rim + off)
  for (let i = 0; i < 3; i++) {
    const v1x = vX[i]
    const v2x = vX[i + 1]
    const v1y = i === 0 ? rim + off : rim + off - 0.02 + n1(t * 2.7 + i + 9) * 0.02
    const v2y = i === 2 ? rim + off : rim + off - 0.02 + n1(t * 2.7 + i + 10) * 0.02
    const h = Hh[i] * flare * (1 + 0.2 * n1(t * 3.1 + i * 2.2 + 5))
    const tx =
      (v1x + v2x) / 2 + LN[i] * 0.5 + sway * h * 0.6 + 0.05 * n1(t * 4.2 + i * 3.1 + 7)
    const ty = rim + off - h
    ctx.bezierCurveTo(
      v1x + (tx - v1x) * 0.12,
      v1y - h * 0.14,
      tx + (v1x - tx) * 0.3,
      ty + h * 0.4,
      tx,
      ty,
    )
    ctx.bezierCurveTo(
      tx + (v2x - tx) * 0.3,
      ty + h * 0.4,
      v2x + (tx - v2x) * 0.12,
      v2y - h * 0.14,
      v2x,
      v2y,
    )
  }
  ctx.closePath()
}

function armStroke(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  hx: number,
  hy: number,
  bend: number,
  outlineC: string,
  limbC: string,
) {
  const mx = (sx + hx) / 2 + bend
  const my = (sy + hy) / 2 + Math.abs(bend) * 0.35
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.beginPath()
  ctx.moveTo(sx, sy)
  ctx.quadraticCurveTo(mx, my, hx, hy)
  ctx.strokeStyle = outlineC
  ctx.lineWidth = 0.205
  ctx.stroke()
  ctx.strokeStyle = limbC
  ctx.lineWidth = 0.15
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(hx, hy, 0.096, 0, 6.2832)
  ctx.fillStyle = limbC
  ctx.fill()
  ctx.strokeStyle = outlineC
  ctx.lineWidth = 0.03
  ctx.stroke()
}

function foot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rot: number,
  outlineC: string,
  limbC: string,
  edgeC: string,
) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rot)
  ctx.beginPath()
  ctx.ellipse(0, 0, 0.135, 0.095, 0, 0, 6.2832)
  const g = ctx.createLinearGradient(0, -0.1, 0, 0.1)
  g.addColorStop(0, limbC)
  g.addColorStop(1, edgeC)
  ctx.fillStyle = g
  ctx.fill()
  ctx.strokeStyle = outlineC
  ctx.lineWidth = 0.045
  ctx.stroke()
  ctx.restore()
}

function eye(
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  ex: number,
  ey: number,
  r: number,
  lid: number,
  happy: boolean,
) {
  if (happy) {
    ctx.strokeStyle = pal.eye
    ctx.lineWidth = 0.05
    ctx.lineCap = "round"
    ctx.beginPath()
    ctx.arc(ex, ey + 0.03, r * 0.85, Math.PI * 1.1, Math.PI * 1.9)
    ctx.stroke()
    return
  }
  ctx.save()
  ctx.beginPath()
  ctx.arc(ex, ey, r, 0, 6.2832)
  ctx.clip()
  const g = ctx.createRadialGradient(ex, ey - r * 0.25, r * 0.1, ex, ey, r)
  g.addColorStop(0, "#170A04")
  g.addColorStop(0.72, "#241009")
  g.addColorStop(1, "#5C3117")
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(ex, ey, r, 0, 6.2832)
  ctx.fill()
  ctx.fillStyle = "#fff"
  ctx.beginPath()
  ctx.arc(ex - r * 0.36, ey - r * 0.36, r * 0.33, 0, 6.2832)
  ctx.fill()
  ctx.globalAlpha = 0.85
  ctx.beginPath()
  ctx.arc(ex + r * 0.32, ey + r * 0.3, r * 0.14, 0, 6.2832)
  ctx.fill()
  ctx.globalAlpha = 1
  if (lid < 1) {
    ctx.fillStyle = pal.innMid
    ctx.fillRect(ex - r * 1.1, ey - r * 1.1, r * 2.2, r * 2.2 * (1 - lid))
  }
  ctx.restore()
}

const SPECKS: [number, number, number][] = [
  [-0.34, -0.4, 0.03],
  [0.36, -0.55, 0.026],
  [-0.15, -0.85, 0.02],
  [0.2, -1.0, 0.02],
  [-0.43, 0.02, 0.022],
  [0.44, 0.12, 0.02],
]
const FRECKS: [number, number][] = [
  [-0.1, 0.42],
  [0.14, 0.47],
  [0.02, 0.53],
]

export function drawPip(
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  dark: boolean,
  t: number,
  o: PipPose,
) {
  const A = o.angry || 0
  const C_out = A > 0 ? mixHex(dark ? "#D5380C" : "#C23208", "#7E1000", A * 0.85) : pal.outline
  const C_in = A > 0 ? mixHex(dark ? "#FFB13D" : "#FFA92F", "#FF6030", A * 0.8) : pal.bodyIn
  const C_mid = A > 0 ? mixHex(dark ? "#FF7A1C" : "#FA6D12", "#E82508", A * 0.85) : pal.bodyMid
  const C_edg = A > 0 ? mixHex(dark ? "#F04A0E" : "#E03E06", "#A81403", A * 0.9) : pal.bodyEdge
  const C_lmb = A > 0 ? mixHex(dark ? "#FF9A28" : "#FB8E1C", "#E8380E", A * 0.8) : pal.limb
  const C_inm = A > 0 ? mixHex("#FFE562", "#FFB84A", A * 0.7) : pal.innMid
  ctx.save()
  ctx.translate(o.x, o.y)
  let shA = clamp(1 - (o.speed || 0) / 900, 0, 1) * 0.9
  if (o.pull) shA *= 0.14
  if (o.jet > 0.3) shA *= 0.3
  ctx.globalAlpha = shA
  ctx.beginPath()
  ctx.ellipse(0, o.S * 0.86, o.S * 0.6 * o.sx, o.S * 0.13, 0, 0, 6.2832)
  ctx.fillStyle = pal.shadow
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.rotate(o.tilt)
  ctx.scale(o.S * o.sx * o.face, o.S * o.sy)
  ctx.lineJoin = "round"

  /* jetpack sits behind everything */
  if (o.jet > 0.02) {
    const th = o.jet
    ctx.save()
    ctx.translate(-0.52, 0.02)
    ctx.rotate(0.5)
    const fl = 0.5 + 0.3 * th + 0.18 * Math.abs(n1(t * 34))
    ctx.beginPath()
    ctx.moveTo(-0.05, 0.3)
    ctx.quadraticCurveTo(0, 0.3 + fl * 1.25, 0.05, 0.3)
    ctx.closePath()
    ctx.fillStyle = pal.jetEdge
    ctx.globalAlpha = th * 0.9
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(-0.035, 0.3)
    ctx.quadraticCurveTo(0, 0.3 + fl * 0.8, 0.035, 0.3)
    ctx.closePath()
    ctx.fillStyle = pal.jetMid
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(-0.02, 0.3)
    ctx.quadraticCurveTo(0, 0.3 + fl * 0.45, 0.02, 0.3)
    ctx.closePath()
    ctx.fillStyle = pal.jetCore
    ctx.fill()
    ctx.globalAlpha = 1
    /* the pack */
    ctx.beginPath()
    if (typeof ctx.roundRect === "function")
      ctx.roundRect(-0.13, -0.3, 0.26, 0.6, 0.09)
    else ctx.rect(-0.13, -0.3, 0.26, 0.6)
    ctx.fillStyle = pal.steel
    ctx.fill()
    ctx.lineWidth = 0.035
    ctx.strokeStyle = pal.steelEdge
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(-0.06, 0.3)
    ctx.lineTo(-0.05, 0.38)
    ctx.lineTo(0.05, 0.38)
    ctx.lineTo(0.06, 0.3)
    ctx.closePath()
    ctx.fillStyle = pal.steelEdge
    ctx.fill()
    ctx.fillStyle = pal.bodyEdge
    ctx.beginPath()
    ctx.arc(0, -0.12, 0.045, 0, 6.2832)
    ctx.fill()
    ctx.restore()
  }

  let sway = n1(t * 2.2) * 0.09 - (o.velX || 0) * 0.0009
  sway = clamp(sway, -0.28, 0.28)

  /* ---- feet ---- */
  if (o.pull) {
    const sw = Math.sin(t * 3.1) * 0.12 + o.pullK * 0.05
    foot(ctx, -0.17 + sw * 0.3, 0.8 + Math.abs(sw) * 0.06, sw * 0.8, C_out, C_lmb, C_edg)
    foot(ctx, 0.17 + sw * 0.26, 0.83 + Math.abs(sw) * 0.05, sw * 0.8 + 0.1, C_out, C_lmb, C_edg)
  } else if (o.walkPh != null) {
    const pL = Math.sin(o.walkPh)
    const pR = Math.sin(o.walkPh + 3.1416)
    foot(ctx, -0.19 + pL * 0.07, 0.64 - Math.max(0, pL) * 0.1, pL * 0.35, C_out, C_lmb, C_edg)
    foot(ctx, 0.19 + pR * 0.07, 0.64 - Math.max(0, pR) * 0.1, pR * 0.35, C_out, C_lmb, C_edg)
  } else {
    const fk = clamp((o.speed || 0) / 700, 0, 1)
    foot(ctx, -0.19 - fk * 0.1, 0.64, -fk * 0.5 + n1(t * 9) * 0.12 * fk, C_out, C_lmb, C_edg)
    foot(ctx, 0.19 - fk * 0.14, 0.64, -fk * 0.6 + n1(t * 9 + 2) * 0.12 * fk, C_out, C_lmb, C_edg)
  }

  /* ---- body ---- */
  bodyPath(ctx, t, sway, o.flare)
  const g = ctx.createRadialGradient(0, 0.18, 0.1, 0, -0.05, 1.15)
  g.addColorStop(0, C_in)
  g.addColorStop(0.55, C_mid)
  g.addColorStop(1, C_edg)
  ctx.fillStyle = g
  ctx.fill()
  ctx.strokeStyle = C_out
  ctx.lineWidth = 0.075
  ctx.stroke()
  innerPath(ctx, t, sway * 1.15, o.flare)
  const gi = ctx.createRadialGradient(0, 0.22, 0.05, 0, 0.05, 0.72)
  gi.addColorStop(0, pal.innIn)
  gi.addColorStop(0.55, C_inm)
  gi.addColorStop(1, pal.innEdge)
  ctx.fillStyle = gi
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(0, 0.3, 0.13, 0.17 + n1(t * 7) * 0.015, 0, 0, 6.2832)
  ctx.fillStyle = pal.core
  ctx.globalAlpha = 0.85
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.fillStyle = pal.speck
  for (const s of SPECKS) {
    ctx.beginPath()
    ctx.ellipse(s[0], s[1], s[2], s[2] * 1.5, -0.4, 0, 6.2832)
    ctx.fill()
  }
  ctx.fillStyle = pal.freckle
  for (const f of FRECKS) {
    ctx.beginPath()
    ctx.arc(f[0], f[1], 0.016, 0, 6.2832)
    ctx.fill()
  }

  /* ---- face ---- */
  const ex = 0.165
  const eyY = 0.02
  const er = 0.15
  const gx = o.gazeX * 0.055
  const gy = o.gazeY * 0.04
  if (A > 0.25) {
    /* angry brows: slammed down toward the nose */
    ctx.strokeStyle = mixHex("#B5470F", "#5f0d02", A * 0.8)
    ctx.lineWidth = 0.05
    ctx.lineCap = "round"
    ctx.beginPath()
    ctx.moveTo(-ex - 0.1 + gx, -0.26 + gy)
    ctx.lineTo(-ex + 0.07 + gx, -0.14 + gy)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(ex + 0.1 + gx, -0.26 + gy)
    ctx.lineTo(ex - 0.07 + gx, -0.14 + gy)
    ctx.stroke()
  } else {
    ctx.strokeStyle = pal.brow
    ctx.lineWidth = 0.033
    ctx.lineCap = "round"
    const braise = o.startled ? -0.06 : 0
    const bworry = o.shy * 0.03
    ctx.beginPath()
    ctx.moveTo(-ex - 0.09 + gx, -0.19 + braise + bworry + gy)
    ctx.quadraticCurveTo(-ex + gx, -0.245 + braise + gy, -ex + 0.09 + gx, -0.2 + braise + gy)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(ex - 0.09 + gx, -0.2 + braise + gy)
    ctx.quadraticCurveTo(ex + gx, -0.245 + braise + gy, ex + 0.09 + gx, -0.19 + braise + bworry + gy)
    ctx.stroke()
  }
  const happyEyes = (o.giggle > 0.5 || (o.happy && o.shy < 0.3)) && A < 0.3
  const lid = o.lid * (1 - A * 0.28) * (1 - (o.effort || 0) * 0.35)
  eye(ctx, pal, -ex + gx, eyY + gy, er, lid, happyEyes)
  eye(ctx, pal, ex + gx, eyY + gy, er, lid, happyEyes)
  const bA = 0.3 + o.shy * 0.45 + o.giggle * 0.2 + A * 0.5 + (o.effort || 0) * 0.3
  ctx.globalAlpha = clamp(bA, 0, 0.9)
  ctx.fillStyle = pal.blush
  ctx.beginPath()
  ctx.ellipse(-0.35, 0.16, 0.085, 0.055, 0, 0, 6.2832)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(0.35, 0.16, 0.085, 0.055, 0, 0, 6.2832)
  ctx.fill()
  ctx.strokeStyle = pal.blush
  ctx.lineWidth = 0.014
  ctx.globalAlpha = clamp(bA * 0.9, 0, 0.7)
  for (let i = -1; i <= 1; i += 2) {
    for (let j = -1; j <= 1; j++) {
      ctx.beginPath()
      ctx.moveTo(i * 0.35 + j * 0.026 - 0.012, 0.128)
      ctx.lineTo(i * 0.35 + j * 0.026 + 0.012, 0.192)
      ctx.stroke()
    }
  }
  ctx.globalAlpha = 1

  /* ---- mouth ---- */
  if (A > 0.5) {
    ctx.fillStyle = pal.eye
    ctx.beginPath()
    ctx.ellipse(0.02, 0.2, 0.075, 0.055, 0, 0, 6.2832)
    ctx.fill()
    ctx.fillStyle = "#fff"
    ctx.fillRect(-0.045, 0.155, 0.13, 0.026)
  } else if (o.startled) {
    ctx.fillStyle = pal.eye
    ctx.beginPath()
    ctx.ellipse(0.02, 0.21, 0.035, 0.045, 0, 0, 6.2832)
    ctx.fill()
  } else if ((o.effort || 0) > 0.55) {
    ctx.strokeStyle = pal.eye
    ctx.lineWidth = 0.034
    ctx.lineCap = "round"
    ctx.beginPath()
    ctx.moveTo(-0.05, 0.2)
    ctx.lineTo(0.09, 0.2)
    ctx.stroke()
  } else if (o.giggle < 0.5) {
    ctx.strokeStyle = pal.eye
    ctx.lineWidth = 0.034
    ctx.lineCap = "round"
    const mw = o.happy ? 0.085 : 0.06
    ctx.beginPath()
    ctx.arc(0.03, 0.16, mw, 0.35, Math.PI - 0.35)
    ctx.stroke()
  }

  /* ---- arms ---- */
  if (o.pull) {
    const gyy = o.pull.grip
    armStroke(ctx, -0.3, -0.08, -0.2, gyy, -0.06, C_out, C_lmb)
    armStroke(ctx, 0.3, -0.08, 0.2, gyy, 0.06, C_out, C_lmb)
  } else if (o.push) {
    armStroke(ctx, -0.08, 0.16, 0.58, 0.06, 0.06, C_out, C_lmb)
    armStroke(ctx, 0.34, 0.24, 0.6, 0.3, 0.1, C_out, C_lmb)
  } else if (o.jet > 0.4) {
    armStroke(ctx, -0.4, 0.2, -0.45, 0.5, -0.14, C_out, C_lmb)
    armStroke(ctx, 0.4, 0.2, 0.5, 0.44, 0.14, C_out, C_lmb)
  } else {
    const Lr = { x: -0.56, y: 0.44 }
    const Rr = { x: 0.56, y: 0.44 }
    const Lh = { x: lerp(Lr.x, -0.15, o.hide), y: lerp(Lr.y, 0.0, o.hide) }
    const covR = Math.max(o.hide, clamp(o.giggle + o.shy * 0.8, 0, 1))
    const Rt = o.hide > 0.4 ? { x: 0.15, y: 0.0 } : { x: 0.1, y: 0.17 }
    let Rh = { x: lerp(Rr.x, Rt.x, covR), y: lerp(Rr.y, Rt.y, covR) }
    const wave =
      o.happy && o.shy < 0.3 && o.giggle < 0.3 ? Math.sin(t * 7) * 0.14 : 0
    if (wave) Rh = { x: 0.6, y: 0.05 - Math.abs(wave) }
    if ((o.rage || 0) > 0.3) {
      const shake = Math.sin(t * 30) * 0.05 * o.rage
      Rh = { x: 0.46 + shake, y: -0.5 + Math.abs(shake) * 0.4 }
    }
    if ((o.windup || 0) > 0.02) {
      Rh = { x: 0.28, y: -0.62 - o.windup * 0.14 }
    }
    /* a held tool owns the hand(s): the arm reaches to the grip point and
       the tool (front layer) draws the closed hand over its handle */
    if (o.grip) Rh = { x: o.grip.x, y: o.grip.y }
    const Lf = o.gripB ?? Lh
    armStroke(ctx, -0.4, 0.2, Lf.x, Lf.y, o.gripB ? 0.14 : -0.1 - o.hide * 0.1, C_out, C_lmb)
    armStroke(ctx, 0.4, 0.2, Rh.x, Rh.y + (o.grip ? 0 : wave * 0.5), 0.1 + covR * 0.12, C_out, C_lmb)
  }

  /* ---- accessories (hats & friends, see src/pip/accessories) ---- */
  for (const acc of accessories) acc.draw(ctx, o, pal, t)

  ctx.restore()
}
