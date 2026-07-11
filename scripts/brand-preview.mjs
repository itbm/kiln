// Renders the brand candidates comparison sheet to shots/brand-candidates.png
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"

mkdirSync("shots", { recursive: true })

const defs = `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#e08a5f"/>
    <stop offset="1" stop-color="#c05f3c"/>
  </linearGradient>
</defs>`

export const MARKS = {
  kiln: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}
  <rect width="512" height="512" rx="116" fill="url(#bg)"/>
  <path d="M122 384 V270 C122 194 182 134 256 134 C330 134 390 194 390 270 V384 Z" fill="#fdf6ef"/>
  <path d="M258 196 C262 238 306 268 306 316 C306 346 284 368 256 368 C228 368 206 346 206 316 C206 288 222 270 234 252 C240 262 246 268 252 270 C246 244 248 220 258 196 Z" fill="url(#bg)"/>
  <rect x="98" y="384" width="316" height="28" rx="14" fill="#fdf6ef"/>
</svg>`,
  wren: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}
  <rect width="512" height="512" rx="116" fill="url(#bg)"/>
  <g fill="#fdf6ef">
    <path d="M108 142 L222 288 L158 330 Z"/>
    <circle cx="258" cy="302" r="116"/>
    <circle cx="330" cy="198" r="66"/>
    <path d="M388 180 L442 198 L386 220 Z"/>
  </g>
  <circle cx="346" cy="186" r="11" fill="#b85838"/>
</svg>`,
  umber: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}
  <rect width="512" height="512" rx="116" fill="#f5efe4"/>
  <path d="M92 384 A164 164 0 0 1 420 384" stroke="#7a4f33" stroke-width="38" fill="none"/>
  <path d="M146 384 A110 110 0 0 1 366 384" stroke="#c96442" stroke-width="38" fill="none"/>
  <path d="M200 384 A56 56 0 0 1 312 384" stroke="#e6a878" stroke-width="38" fill="none"/>
  <rect x="74" y="384" width="364" height="24" rx="12" fill="#4a3527"/>
</svg>`,
}

const row = (id, name, tagline, note) => `
<div class="row">
  <img class="big" src="data:image/svg+xml;base64,${Buffer.from(MARKS[id]).toString("base64")}">
  <img class="small" src="data:image/svg+xml;base64,${Buffer.from(MARKS[id]).toString("base64")}">
  <div class="text">
    <div class="word">${name}</div>
    <div class="tag">${tagline}</div>
    <div class="note">${note}</div>
  </div>
</div>`

const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#faf9f5;font-family:Georgia,serif;color:#1f1e1b;padding:36px 40px}
  h1{font-size:22px;margin:0 0 6px} .sub{font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#71706a;margin-bottom:28px}
  .row{display:flex;align-items:center;gap:26px;padding:22px 0;border-top:1px solid #e4e2d8}
  .big{width:120px;height:120px;border-radius:27px;box-shadow:0 6px 18px rgba(0,0,0,.12)}
  .small{width:56px;height:56px;border-radius:13px;box-shadow:0 3px 8px rgba(0,0,0,.14)}
  .word{font-size:34px;font-weight:600;letter-spacing:-.5px}
  .tag{font-family:-apple-system,system-ui,sans-serif;font-size:14px;color:#57554e;margin-top:2px}
  .note{font-family:-apple-system,system-ui,sans-serif;font-size:12px;color:#8f8d84;margin-top:6px}
</style>
<h1>Rebrand candidates</h1>
<div class="sub">Each shown at store size and home-screen size, with the serif wordmark used in-app.</div>
${row("kiln", "Kiln", "Where ideas get fired. Pottery-warm — matches the terracotta palette exactly.", "Collisions: a model-fine-tuning tool (getkiln.ai) and a crypto staker use the name; irrelevant for a personal app.")}
${row("wren", "Wren", "A small bird that chats. Friendly mascot energy, warm brown like the palette.", "Collisions: wren.co (carbon offsets), Wren Kitchens (UK). No AI-chat clash.")}
${row("umber", "Umber", "Burnt-umber pigment — literally this app's colour family. Quiet echo of “Amber”.", "Collisions: essentially none of note.")}
`

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
})
const page = await browser.newPage({
  viewport: { width: 860, height: 700 },
  deviceScaleFactor: 2,
})
await page.setContent(html)
await page.waitForTimeout(300)
await page.screenshot({ path: "shots/brand-candidates.png", fullPage: true })
await browser.close()
console.log("wrote shots/brand-candidates.png")
