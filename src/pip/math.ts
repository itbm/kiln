/** Small math helpers shared across Pip's engine and actions. */

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v
}

export function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx
  const dy = ay - by
  return Math.sqrt(dx * dx + dy * dy)
}

export function easeIO(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

export function easeOutBack(x: number): number {
  const c = 1.70158
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2)
}

/** Layered sine noise in roughly [-1, 1] — Pip's organic wobble. */
export function n1(x: number): number {
  return (
    Math.sin(x) * 0.55 +
    Math.sin(x * 2.17 + 1.3) * 0.3 +
    Math.sin(x * 4.31 + 2.1) * 0.15
  )
}
