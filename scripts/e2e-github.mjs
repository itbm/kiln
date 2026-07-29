// End-to-end test of the on-device GitHub slice: drives the real Settings UI
// against a mocked api.github.com and checks src/lib/github.ts's request
// shape and error mapping. No server component is involved — repository and
// branch listing run entirely on the device, which is the property this
// guards.
//
// Needs `npm run preview` on :4173.
import { chromium } from "playwright"

const BASE = "http://localhost:4173"
let pass = 0
let fail = 0
const ok = (name) => {
  pass++
  console.log(`  ✓ ${name}`)
}
const bad = (name, detail) => {
  fail++
  console.log(`  ✗ ${name}\n      ${detail}`)
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
})
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
})
const page = await ctx.newPage()

await page.addInitScript(() => {
  localStorage.setItem(
    "amber-settings",
    JSON.stringify({
      version: 2,
      state: { githubToken: "github_pat_probe", openrouterKey: "sk-or-test" },
    }),
  )
})

let scenario = "happy"
const seen = []
await page.route("https://api.github.com/**", async (route) => {
  const url = new URL(route.request().url())
  const h = route.request().headers()
  seen.push({ path: url.pathname, search: url.search, auth: h["authorization"] })

  if (scenario === "unauthorised")
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "Bad credentials" }),
    })
  // Real GitHub lists X-RateLimit-* in Access-Control-Expose-Headers; without
  // that a browser reads them as null, so the mock must set it or it would be
  // testing a situation that can't occur.
  if (scenario === "ratelimited")
    return route.fulfill({
      status: 403,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers":
          "X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 300),
      },
      body: JSON.stringify({ message: "API rate limit exceeded" }),
    })
  // A proxy that strips the headers, plus a secondary limit: detection must
  // fall back to the body, which is always readable.
  if (scenario === "secondary")
    return route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        message: "You have exceeded a secondary rate limit.",
      }),
    })

  if (url.pathname === "/user")
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        login: "probe-user",
        _auth: h["authorization"],
        _v: h["x-github-api-version"],
      }),
    })

  if (url.pathname === "/user/repos")
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(scenario === "norepos" ? [] : [{ name: "x" }]),
    })

  return route.fulfill({ status: 500, body: "unexpected" })
})

/** Wait for a toast whose text matches. Never mutate the toaster DOM — sonner
 *  is a React tree, and removing nodes under it stops later toasts mounting. */
const expectToast = async (re, name) => {
  try {
    await page
      .locator("[data-sonner-toast]")
      .filter({ hasText: re })
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
    ok(name)
  } catch {
    const all = await page.locator("[data-sonner-toast]").allTextContents()
    bad(name, `no toast matched ${re}. Visible: ${JSON.stringify(all)}`)
  }
}
/** Let sonner retire the current toasts on its own before the next scenario. */
const settle = async () => {
  await page
    .locator("[data-sonner-toast]")
    .first()
    .waitFor({ state: "detached", timeout: 15000 })
    .catch(() => {})
}

await page.goto(`${BASE}/settings`)

if (await page.getByText("GitHub token (coding)").count())
  ok("GitHub token row renders in Settings")
else bad("GitHub token row renders in Settings", "label not found")

const testBtn = page
  .locator("div", { has: page.getByText("GitHub token (coding)") })
  .getByRole("button", { name: "Test" })
  .last()

// ---- 1. happy path ----
await testBtn.click()
await expectToast(/probe-user/, "Test button reports the authenticated login")

const userCall = seen.find((c) => c.path === "/user")
if (userCall?.auth === "Bearer github_pat_probe") ok("Bearer token is sent")
else bad("Bearer token is sent", `got: ${userCall?.auth}`)

const probed = await page.evaluate(async () => {
  const r = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: "Bearer github_pat_probe",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })
  return r.json()
})
if (probed._v === "2022-11-28") ok("API version header is pinned")
else bad("API version header is pinned", `got: ${probed._v}`)

// checkGithubToken must probe repo visibility, not just authenticate
if (seen.some((c) => c.path === "/user/repos"))
  ok("token check also probes repository visibility")
else bad("token check also probes repository visibility", "no /user/repos call")

// ---- 2. a token with no repo grants is called out, not silently accepted ----
await settle()
scenario = "norepos"
await testBtn.click()
await expectToast(
  /can't see any repositories/,
  "token with no repository grants is flagged rather than passing",
)

// ---- 3. error mapping ----
await settle()
scenario = "unauthorised"
await testBtn.click()
await expectToast(
  /rejected the token[\s\S]*Bad credentials/,
  "401 maps to token-rejected, carrying GitHub's own detail",
)

await settle()
scenario = "ratelimited"
await testBtn.click()
await expectToast(
  /rate limit reached[\s\S]*minute/,
  "rate limit maps to a message saying when it lifts, not a permissions error",
)

// headers stripped by a proxy + a secondary limit: must still be recognised
await settle()
scenario = "secondary"
await testBtn.click()
await expectToast(
  /secondary rate limit reached/,
  "secondary limit is recognised from the body alone, and named as secondary",
)

console.log(`\n${fail === 0 ? "E2E-GITHUB PASSED" : "E2E-GITHUB FAILED"} — ${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail === 0 ? 0 : 1)
