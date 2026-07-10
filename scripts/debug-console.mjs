import { chromium } from "playwright"
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" })
const page = await browser.newPage()
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[${m.type()}]`, m.text().slice(0, 500)) })
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 800), "\n", (e.stack||"").split("\n").slice(0,5).join("\n")))
await page.goto("http://localhost:4173/", { waitUntil: "networkidle" })
await page.waitForTimeout(1500)
console.log("body text len:", (await page.textContent("body"))?.length)
await browser.close()
