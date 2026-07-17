import { lerp } from "./math"

/** Pip's paint box. Values are scheme-aware (dark vs light app background). */
export interface Palette {
  outline: string
  bodyIn: string
  bodyMid: string
  bodyEdge: string
  innIn: string
  innMid: string
  innEdge: string
  core: string
  limb: string
  eye: string
  brow: string
  blush: string
  speck: string
  freckle: string
  dropFill: string
  shadow: string
  bar: string
  wood: string
  woodDark: string
  woodMid: string
  steel: string
  steelEdge: string
  smoke: string
  sweat: string
  jetCore: string
  jetMid: string
  jetEdge: string
}

export function buildPalette(dark: boolean): Palette {
  const d = dark
  return {
    outline: d ? "#D5380C" : "#C23208",
    bodyIn: d ? "#FFB13D" : "#FFA92F",
    bodyMid: d ? "#FF7A1C" : "#FA6D12",
    bodyEdge: d ? "#F04A0E" : "#E03E06",
    innIn: "#FFF6BE",
    innMid: "#FFE562",
    innEdge: "#FFC02E",
    core: "#FFFBE2",
    limb: d ? "#FF9A28" : "#FB8E1C",
    eye: "#221007",
    brow: "#B5470F",
    blush: "#FF6A56",
    speck: "rgba(255,255,255,.55)",
    freckle: "rgba(220,90,20,.5)",
    dropFill: d ? "#FFC148" : "#F09A20",
    shadow: d ? "rgba(0,0,0,.4)" : "rgba(120,40,10,.18)",
    bar: d ? "rgba(243,238,231,.5)" : "rgba(27,22,19,.45)",
    wood: "#8a5a33",
    woodDark: "#63401f",
    woodMid: "#c98a4b",
    steel: "#d7dde3",
    steelEdge: "#5c666e",
    smoke: d ? "#6f6a64" : "#8d857c",
    sweat: "#9ECBFF",
    jetCore: "#FFF3B0",
    jetMid: "#FFB13D",
    jetEdge: "#F04A0E",
  }
}

function hex2(c: string): [number, number, number] {
  return [
    parseInt(c.substring(1, 3), 16),
    parseInt(c.substring(3, 5), 16),
    parseInt(c.substring(5, 7), 16),
  ]
}

/** Mix two #rrggbb colours; k=0 → a, k=1 → b. */
export function mixHex(a: string, b: string, k: number): string {
  const A = hex2(a)
  const B = hex2(b)
  const r = Math.round(lerp(A[0], B[0], k))
  const g = Math.round(lerp(A[1], B[1], k))
  const bl = Math.round(lerp(A[2], B[2], k))
  return `rgb(${r},${g},${bl})`
}
