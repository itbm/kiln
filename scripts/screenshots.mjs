// Takes the README screenshot set: one row per app theme × colour scheme
// (Ember dark/light, Classic dark/light), four states per row.
// vite preview must be running on :4173. Usage: node scripts/screenshots.mjs [outDir]
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

const OUT = resolve(process.argv[2] ?? "shots")
mkdirSync(OUT, { recursive: true })
const BASE = "http://localhost:4173"

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
})

const ROWS = [
  { theme: "ember", scheme: "dark" },
  { theme: "ember", scheme: "light" },
  { theme: "classic", scheme: "dark" },
  { theme: "classic", scheme: "light" },
]

for (const { theme, scheme } of ROWS) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: scheme,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  })
  const page = await ctx.newPage()
  // Pick the app theme before first paint; scheme follows the emulated
  // prefers-color-scheme (settings default "system"). seedDemo merges its
  // own settings on top without touching appTheme.
  await page.addInitScript(
    ([t]) => {
      if (!localStorage.getItem("amber-settings"))
        localStorage.setItem(
          "amber-settings",
          JSON.stringify({ version: 0, state: { appTheme: t } }),
        )
    },
    [theme],
  )

  const shot = async (name, settle = 450) => {
    await page.waitForTimeout(settle)
    await page.screenshot({ path: `${OUT}/${theme}-${scheme}-${name}.png` })
    console.log("📸", `${theme}-${scheme}-${name}`)
  }

  await page.goto(`${BASE}/?seed=1`, { waitUntil: "networkidle" })
  await page.waitForTimeout(900)

  // new chat (Ember: Pip on his ring)
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" })
  await shot("new-chat", 1200)

  // conversation with markdown + table
  await page.goto(`${BASE}/chat/demo-kyoto`, { waitUntil: "networkidle" })
  await shot("chat", 1200)

  // artefact viewer (Strata landing page preview)
  await page.goto(`${BASE}/chat/demo-strata`, { waitUntil: "networkidle" })
  await page.getByText("Strata — Landing page").click()
  await shot("artefact", 1600)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(400)

  // model picker
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" })
  await page.getByText("glm-5.2", { exact: true }).click()
  await shot("model-picker", 1600)

  await ctx.close()
}

await browser.close()
console.log("done →", OUT)
