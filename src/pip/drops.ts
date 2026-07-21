import { n1 } from "./math"
import type { Palette } from "./palette"

interface Drop {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  life: number
  rate: number
  col: string | null
}

/** Pip's droplet particles — sparks, smoke puffs, sweat beads, wood chips. */
export class Drops {
  private drops: Drop[] = []

  spawn(x: number, y: number, burst?: boolean, col?: string | null, rise?: number) {
    this.drops.push({
      x: x + (Math.random() - 0.5) * 14,
      y: y + (Math.random() - 0.5) * 8,
      vx: (Math.random() - 0.5) * (burst ? 160 : 16),
      vy: -(burst ? 60 : 20) - Math.random() * (rise || 30),
      r: 2 + Math.random() * 3,
      life: 1,
      rate: 1 / (0.9 + Math.random() * 0.8),
      col: col || null,
    })
  }

  /** a tear: everything else drifts up like flame — tears dribble DOWN */
  tear(x: number, y: number, col: string) {
    this.drops.push({
      x: x + (Math.random() - 0.5) * 3,
      y,
      vx: (Math.random() - 0.5) * 8,
      vy: 26 + Math.random() * 30,
      r: 1.6 + Math.random() * 1.6,
      life: 1,
      rate: 1 / (0.6 + Math.random() * 0.4),
      col,
    })
  }

  step(dt: number, t: number) {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i]
      d.life -= dt * d.rate
      if (d.life <= 0) {
        this.drops.splice(i, 1)
        continue
      }
      d.x += (d.vx + n1(t * 3 + d.r) * 10) * dt
      d.y += d.vy * dt
      d.vx *= 1 - dt * 1.5
    }
    if (this.drops.length > 60) this.drops.splice(0, this.drops.length - 60)
  }

  draw(ctx: CanvasRenderingContext2D, pal: Palette) {
    for (const d of this.drops) {
      const a = Math.sin(d.life * 3.1416)
      ctx.globalAlpha = a * 0.9
      ctx.beginPath()
      ctx.ellipse(d.x, d.y, d.r, d.r * 1.25, 0, 0, 6.2832)
      ctx.fillStyle = d.col || pal.dropFill
      ctx.fill()
      if (!d.col) {
        ctx.lineWidth = 1
        ctx.strokeStyle = pal.outline
        ctx.globalAlpha = a * 0.6
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
  }
}
