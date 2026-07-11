// Takes mobile-viewport screenshots of the built app (vite preview must be
// running on :4173). Usage: node scripts/screenshots.mjs [outDir]
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

const OUT = resolve(process.argv[2] ?? "shots")
mkdirSync(OUT, { recursive: true })
const BASE = "http://localhost:4173"

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
})

async function makePage(scheme) {
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
  return { ctx, page }
}

async function shot(page, name) {
  await page.waitForTimeout(450)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log("📸", name)
}

// ---------- light mode ----------
let { ctx, page } = await makePage("light")
await page.goto(`${BASE}/?seed=1`, { waitUntil: "networkidle" })
await page.waitForTimeout(800)

await page.goto(`${BASE}/`, { waitUntil: "networkidle" })
await shot(page, "01-new-chat-light")

// sidebar drawer
await page.getByLabel("Open menu").click()
await shot(page, "02-sidebar-light")
await page.keyboard.press("Escape")
await page.waitForTimeout(300)

// conversation with markdown + table
await page.goto(`${BASE}/chat/demo-kyoto`, { waitUntil: "networkidle" })
await shot(page, "03-chat-markdown-light")

// artifact chat + viewer
await page.goto(`${BASE}/chat/demo-coffee`, { waitUntil: "networkidle" })
await shot(page, "04-chat-artifact-light")
await page.getByText("Ember & Oak — Landing page").click()
await page.waitForTimeout(900)
await shot(page, "05-artifact-preview-light")
await page.getByRole("tab", { name: "Source" }).click()
await shot(page, "06-artifact-source-light")
await page.keyboard.press("Escape")

// reasoning + code artifact (ollama model)
await page.goto(`${BASE}/chat/demo-owid`, { waitUntil: "networkidle" })
await page.getByText(/Thought for/).click()
await shot(page, "07-chat-reasoning-light")

// model picker
await page.goto(`${BASE}/`, { waitUntil: "networkidle" })
await page.getByText("Claude Sonnet 4.5").click()
await page.waitForTimeout(600)
await shot(page, "08-model-picker-light")
await page.getByPlaceholder("Search models…").fill("gem")
await shot(page, "09-model-picker-search-light")
await page.keyboard.press("Escape")

// settings
await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" })
await shot(page, "10-settings-light")
await page.evaluate(() => {
  document.querySelector("#skills")?.scrollIntoView({ block: "start" })
})
await shot(page, "11-settings-skills-light")

// images studio
await page.goto(`${BASE}/images/demo-images`, { waitUntil: "networkidle" })
await shot(page, "12-images-light")

// effort menu
await page.goto(`${BASE}/`, { waitUntil: "networkidle" })
await page.getByText("Effort", { exact: true }).click()
await shot(page, "17-effort-menu-light")
await page.keyboard.press("Escape")

// slash command menu
await page.getByPlaceholder("Message Kiln…").fill("/")
await page.waitForTimeout(300)
await shot(page, "21-slash-menu-light")
await page.getByPlaceholder("Message Kiln…").fill("")

// skills sheet from ＋ menu
await page.getByLabel("More options").click()
await page.getByText("Skills", { exact: true }).click()
await page.waitForTimeout(500)
await shot(page, "18-skills-sheet-light")
await page.keyboard.press("Escape")

// delete confirmation dialog
await page.goto(`${BASE}/chat/demo-kyoto`, { waitUntil: "networkidle" })
await page.getByLabel("Chat options").click()
await page.getByText("Delete chat").click()
await page.waitForTimeout(400)
await shot(page, "19-delete-dialog-light")
await page.keyboard.press("Escape")

await ctx.close()

// ---------- dark mode ----------
;({ ctx, page } = await makePage("dark"))
await page.goto(`${BASE}/?seed=1`, { waitUntil: "networkidle" })
await page.waitForTimeout(800)
await page.goto(`${BASE}/`, { waitUntil: "networkidle" })
await shot(page, "13-new-chat-dark")
await page.goto(`${BASE}/chat/demo-kyoto`, { waitUntil: "networkidle" })
await shot(page, "14-chat-markdown-dark")
await page.goto(`${BASE}/chat/demo-coffee`, { waitUntil: "networkidle" })
await shot(page, "15-chat-artifact-dark")
await page.getByText("Ember & Oak — Landing page").click()
await page.waitForTimeout(900)
await page.getByRole("tab", { name: "Source" }).click()
await shot(page, "20-artifact-source-dark")
await page.keyboard.press("Escape")
await page.getByLabel("Open menu").click()
await shot(page, "16-sidebar-dark")
await ctx.close()

await browser.close()
console.log("done →", OUT)
