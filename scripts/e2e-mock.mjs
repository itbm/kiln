// End-to-end smoke test: drives the real UI against a mocked OpenRouter +
// Tavily backend. Verifies streaming, the tool loop, artifact parsing,
// persistence and title generation. Needs `npm run preview` on :4173.
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"

const BASE = "http://localhost:4173"
mkdirSync("shots", { recursive: true })

const sse = (events) =>
  events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") +
  "\n\ndata: [DONE]\n\n"

const chunk = (delta, finish = null, usage = null) => ({
  id: "gen-1",
  choices: [{ delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
})

// Round 1: model asks for a web search
const round1 = sse([
  chunk({ role: "assistant", content: "" }),
  chunk({
    tool_calls: [
      {
        index: 0,
        id: "call_1",
        function: { name: "web_search", arguments: '{"query":"best esp' },
      },
    ],
  }),
  chunk({
    tool_calls: [{ index: 0, function: { arguments: 'resso beans 2026"}' } }],
  }),
  chunk({}, "tool_calls", {
    prompt_tokens: 412,
    completion_tokens: 24,
    cost: 0.0016,
  }),
])

// Round 2: reasoning + prose + a markdown artifact. The reply opens with a
// bare mood tag (the "<thoughtful>" dialect some models use instead of the
// <emotion> wrapper), split mid-tag to exercise the streaming partial-tag
// handling — it must be consumed, never rendered as text.
const round2 = sse([
  chunk({ reasoning: "The search results mention three roasters. " }),
  chunk({ reasoning: "I'll summarise and produce a short guide artifact." }),
  chunk({ content: "<thou" }),
  chunk({ content: "ghtful>\nBased on what I found, here's a quick guide:\n\n" }),
  chunk({
    content:
      '<artifact identifier="espresso-guide" type="text/markdown" title="Espresso beans — quick guide">\n# Espresso beans\n\n',
  }),
  chunk({ content: "- **Fresh roast date** beats brand\n- Medium-dark for milk drinks\n" }),
  chunk({ content: "</artifact>\n\nWant tasting notes for any of these?" }),
  chunk({}, "stop", {
    prompt_tokens: 655,
    completion_tokens: 128,
    cost: 0.0024,
    prompt_tokens_details: { cached_tokens: 300 },
    completion_tokens_details: { reasoning_tokens: 22 },
  }),
])

// Title call
const titleResp = sse([chunk({ content: "Espresso bean picks" }), chunk({}, "stop")])

// Compaction call
const summaryResp = sse([
  chunk({ content: "- User wants espresso bean advice; fresh roast date matters most" }),
  chunk({}, "stop"),
])

// Interactive questions reply — split across chunks mid-tag to exercise
// the streaming partial-tag handling
const questionsResp = sse([
  chunk({ content: "Two quick questions first:\n\n<quest" }),
  chunk({
    content:
      'ions>\n<question text="Where will you deploy?">\n<option>Docker on a VPS</option>\n<option>Fly.io</option>\n<option>Raspberry Pi</option>\n</question>\n<question text="Which auth style do you prefer?">\n<option>Passwords</option>\n<option>OAuth only</option>\n</quest',
  }),
  chunk({ content: "ion>\n</questions>" }),
  chunk({}, "stop"),
])

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
})
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})
const page = await ctx.newPage()

// keys + a models cache so the composer is ready without hitting the network
await page.addInitScript(() => {
  const models = {
    fetchedAt: Date.now(),
    signature: "1:0:/api/ollama",
    v: 2,
    ollama: [],
    openrouter: [
      {
        id: "anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        provider: "openrouter",
        // tiny context so the auto-compaction path triggers in this test
        ctx: 700,
        vision: true,
        reasoning: true,
        tools: true,
        pricing: { prompt: 3, completion: 15 },
      },
    ],
  }
  localStorage.setItem("amber-models-cache", JSON.stringify(models))
  localStorage.setItem(
    "amber-settings",
    JSON.stringify({
      version: 0,
      state: {
        openrouterKey: "sk-or-test",
        tavilyKey: "tvly-test",
        lastModel: { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" },
        webSearchEnabled: true,
        webFetchEnabled: true,
        generateTitles: true,
      },
    }),
  )
})

let orCalls = 0
const bodies = []
await page.route("**/openrouter.ai/api/v1/chat/completions", async (route) => {
  const body = JSON.parse(route.request().postData() ?? "{}")
  bodies.push(body)
  orCalls++
  const system = body.messages?.[0]?.content ?? ""
  const isTitle = system.includes("short titles")
  const isSummary = system.includes("compress chat conversations")
  const lastUser = [...(body.messages ?? [])]
    .reverse()
    .find((m) => m.role === "user")
  const asksQuestions =
    typeof lastUser?.content === "string" &&
    lastUser.content.includes("Ask me setup questions")
  const hasToolResult = body.messages?.some((m) => m.role === "tool")
  const payload = isTitle
    ? titleResp
    : isSummary
      ? summaryResp
      : asksQuestions
        ? questionsResp
        : hasToolResult
          ? round2
          : round1
  await route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: payload,
  })
})
await page.route("**/api.tavily.com/search", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      answer: "Fresh roast dates matter more than brand.",
      results: [
        { title: "Espresso guide", url: "https://example.com/g", content: "Roasters A, B, C lead 2026 rankings." },
      ],
    }),
  }),
)

const errors = []
page.on("pageerror", (e) => errors.push(e.message))

await page.goto(`${BASE}/`, { waitUntil: "networkidle" })

// --- Pip stays on screen when the opening sidebar clobbers him ---
// He idles on the home ring (screen centre), squarely in the drawer's
// path. Open it, let the knock-and-bounce physics fully settle, then
// count his opaque pixels: a ricochet must never carry him off-screen
// (the old single-wall bounce could leave him resting at negative x).
await page.waitForTimeout(1000)
await page.getByLabel("Open menu").click()
await page.waitForTimeout(4500)
const pipPixels = await page.evaluate(() => {
  const cv = document.querySelector("canvas[aria-hidden]")
  const g = cv?.getContext("2d")
  if (!cv || !g) return -1
  const data = g.getImageData(0, 0, cv.width, cv.height).data
  let n = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] > 50) n++
  return n
})
if (pipPixels < 800) {
  console.error(`ASSERT FAIL: Pip off-screen after sidebar knock (${pipPixels} visible px)`)
  process.exitCode = 1
} else console.log(`ok: Pip visible after the sidebar knock (${pipPixels} px)`)
await page.keyboard.press("Escape") // close the drawer (he shoves it shut)
await page.waitForTimeout(600)

await page.getByPlaceholder("Message Kiln…").fill("What espresso beans should I buy?")
await page.getByLabel("Send").click()

// tool chip appears
await page.getByText("Searched “best espresso beans 2026”").waitFor({ timeout: 10000 })
// artifact card appears
await page.getByText("Espresso beans — quick guide").waitFor({ timeout: 10000 })
// generated title lands in the header
await page.getByRole("heading", { name: "Espresso bean picks" }).waitFor({ timeout: 10000 })
await page.waitForTimeout(400)
// the bare mood tag must be consumed by the parser, never shown as text
if (await page.getByText("<thoughtful>").count()) {
  console.error("ASSERT FAIL: bare mood tag leaked into the chat")
  process.exitCode = 1
} else console.log("ok: bare mood tag stripped from the reply")

// --- usage caption: both tool rounds summed, cost from the provider ---
// round1 ($0.0016) + round2 ($0.0024) = $0.004
const usageBtn = page.getByText("$0.004", { exact: true })
await usageBtn.waitFor({ timeout: 5000 })
console.log("ok: usage caption shows summed provider cost")
await usageBtn.click()
const usageDetail = page.getByText(
  "1.1k in (300 cached) · 152 out (22 reasoning) · $0.004",
  { exact: true },
)
await usageDetail.waitFor({ timeout: 5000 })
console.log("ok: caption expands to the full token breakdown")
await usageDetail.click() // collapse again
await page.screenshot({ path: "shots/e2e-stream-result.png" })

// artifact viewer opens with rendered markdown
await page.getByText("Espresso beans — quick guide").click()
await page.getByRole("tab", { name: "Source" }).waitFor({ timeout: 5000 })
await page.screenshot({ path: "shots/e2e-artifact-open.png" })
await page.keyboard.press("Escape")

// persisted? reload and check the message + steps survive
await page.reload({ waitUntil: "networkidle" })
await page.getByText("Searched “best espresso beans 2026”").waitFor({ timeout: 10000 })
await page.getByText("Espresso beans — quick guide").waitFor({ timeout: 5000 })
await page.getByText(/Thought for/).waitFor({ timeout: 5000 })
// stored content is re-split at render time — still no mood-tag leak
if (await page.getByText("<thoughtful>").count()) {
  console.error("ASSERT FAIL: bare mood tag leaked after reload")
  process.exitCode = 1
} else console.log("ok: bare mood tag still hidden after reload")
// usage survives the round-trip through IndexedDB
await page.getByText("$0.004", { exact: true }).waitFor({ timeout: 5000 })
console.log("ok: usage caption persists across reload")

// --- regenerate keeps the old attempt as a version ---
await page.getByLabel("Regenerate").click()
await page.getByText("2/2").waitFor({ timeout: 15000 })
await page.getByLabel("Previous version").click()
await page.getByText("1/2").waitFor({ timeout: 5000 })
await page.getByLabel("Next version").click()
await page.getByText("2/2").waitFor({ timeout: 5000 })
console.log("ok: regenerate created version 2/2 and switcher works")
await page.screenshot({ path: "shots/e2e-versions.png" })

// --- /stats dialog: totals cover BOTH attempts of the regenerated reply ---
await page.getByPlaceholder("Message Kiln…").fill("/stats")
await page.getByLabel("Send").click()
await page.getByText("1 (2 attempts)").waitFor({ timeout: 5000 })
await page.getByText("2.1k (600 cached)").waitFor({ timeout: 5000 })
await page.getByText("304 (44 reasoning)").waitFor({ timeout: 5000 })
await page.getByText("$0.008", { exact: true }).waitFor({ timeout: 5000 })
console.log("ok: /stats sums tokens and cost across attempts")
await page.screenshot({ path: "shots/e2e-usage-stats.png" })
await page.keyboard.press("Escape")
await page.getByText("1 (2 attempts)").waitFor({ state: "detached", timeout: 5000 })

// --- /help command ---
await page.getByPlaceholder("Message Kiln…").fill("/help")
await page.getByLabel("Send").click()
await page.getByText("Slash commands").waitFor({ timeout: 5000 })
await page.getByRole("button", { name: "OK" }).click()
console.log("ok: /help dialog")

// --- second send triggers auto-compaction (ctx=700 in the mock model) ---
await page.getByPlaceholder("Message Kiln…").fill("And which grinder should I get?")
await page.getByLabel("Send").click()
await page
  .getByText(/Compacted — messages above are summarised/)
  .waitFor({ timeout: 20000 })
console.log("ok: auto-compaction divider appeared")
const compactionCall = bodies.find((b) =>
  b.messages?.[0]?.content?.includes("compress chat conversations"),
)
await page.getByText("Want tasting notes for any of these?").last().waitFor({ timeout: 15000 })
// the chat request AFTER compaction must carry the summary in its system prompt
for (let i = 0; i < 40; i++) {
  const injected = bodies.some((b) => {
    const s = b.messages?.[0]?.content ?? ""
    return s.includes("fresh roast date matters most") && !s.includes("compress chat conversations")
  })
  if (injected) break
  await page.waitForTimeout(250)
}
{
  const injected = bodies.some((b) => {
    const s = b.messages?.[0]?.content ?? ""
    return s.includes("fresh roast date matters most") && !s.includes("compress chat conversations")
  })
  console.log("ok: summary injected into system prompt:", injected)
  if (!injected) process.exitCode = 1
}

// --- edit a user message and resend ---
await page.getByLabel("Edit message").first().click()
const editBox = page.locator("textarea").first()
await editBox.fill("What espresso beans should I buy for a Moka pot?")
await page.getByText("Send", { exact: true }).click()
await page.getByRole("button", { name: "Edit & resend" }).click()
await page.getByText("What espresso beans should I buy for a Moka pot?").waitFor({ timeout: 10000 })
await page.getByText("edited").first().waitFor({ timeout: 15000 })
console.log("ok: user message edited and regenerated")
await page.waitForTimeout(1500)
await page.screenshot({ path: "shots/e2e-edited.png" })

// --- interactive questions: auto-open, dismiss/reopen, answer, submit ---
await page.getByPlaceholder("Message Kiln…").fill("Ask me setup questions")
await page.getByLabel("Send").click()
await page.getByText("Question 1 of 2").waitFor({ timeout: 15000 })
console.log("ok: questions sheet auto-opened after streaming")
await page.keyboard.press("Escape")
await page.getByText("2 questions · tap to answer").waitFor({ timeout: 5000 })
await page.getByText("A few questions for you").click()
await page.getByText("Question 1 of 2").waitFor({ timeout: 5000 })
console.log("ok: dismissed to read chat, reopened from card")
await page.getByText("Docker on a VPS").click()
await page.getByRole("button", { name: "Next" }).click()
await page.getByText("Other…").click()
await page.getByPlaceholder("Type your answer…").fill("magic links")
await page.getByRole("button", { name: "Review" }).click()
await page.getByText("magic links").first().waitFor({ timeout: 5000 })
await page.screenshot({ path: "shots/e2e-questions-review.png" })
await page.getByRole("button", { name: "Submit" }).click()
await page
  .getByText("Where will you deploy? — Docker on a VPS")
  .waitFor({ timeout: 10000 })
await page.getByText("Answered ✓").waitFor({ timeout: 10000 })
console.log("ok: answers sent as a message; card marked answered")
// the send happens after (possibly) another auto-compaction — poll for it
for (let i = 0; i < 60; i++) {
  if (bodies.some((b) => JSON.stringify(b.messages).includes("Which auth style do you prefer? — magic links"))) break
  await page.waitForTimeout(250)
}
if (!bodies.some((b) => JSON.stringify(b.messages).includes("Which auth style do you prefer? — magic links"))) {
  console.error("ASSERT FAIL: free-text answer never reached the provider")
  process.exitCode = 1
} else {
  console.log("ok: free-text answer reached the provider")
}
if (!compactionCall) {
  console.error("ASSERT FAIL: no compaction call was made")
  process.exitCode = 1
}

// --- settings: manual update check (live service worker in preview) ---
await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" })
await page.getByRole("button", { name: "Check for updates" }).click()
await page.getByText("You're on the latest version.").waitFor({ timeout: 15000 })
console.log("ok: manual update check reports up to date")
await page.screenshot({ path: "shots/e2e-update-check.png" })

// --- key hygiene: a quoted .env-style paste is sanitised on input ---
// (a quoted key reaches OpenRouter as `Bearer "sk-…"`, which 401s with a
// baffling "Missing Authentication header")
await page.route("**/openrouter.ai/api/v1/models", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: '{"data":[]}' }),
)
const orKeyField = page.locator('input[type="password"]').first()
await orKeyField.fill('OPENROUTER_API_KEY="sk-or-v1-e2e-paste"')
await page.waitForTimeout(200)
const storedKey = await page.evaluate(
  () => JSON.parse(localStorage.getItem("amber-settings") ?? "{}").state?.openrouterKey,
)
if (storedKey !== "sk-or-v1-e2e-paste") {
  console.error(`ASSERT FAIL: pasted key not sanitised (got ${JSON.stringify(storedKey)})`)
  process.exitCode = 1
} else console.log("ok: quoted .env paste sanitised to the bare key")

// request shape checks
const first = bodies[0]
const assertTrue = (cond, msg) => {
  if (!cond) {
    console.error("ASSERT FAIL:", msg)
    process.exitCode = 1
  } else console.log("ok:", msg)
}
assertTrue(first.model === "anthropic/claude-sonnet-4.5", "model id sent")
assertTrue(first.stream === true, "stream requested")
assertTrue(first.usage?.include === true, "usage accounting requested")
assertTrue(first.messages[0].role === "system", "system prompt first")
assertTrue(
  first.tools?.some((t) => t.function.name === "web_search"),
  "web_search tool advertised",
)
const second = bodies.find((b) => b.messages?.some((m) => m.role === "tool"))
assertTrue(!!second, "tool result round-tripped")
assertTrue(
  second?.messages?.some((m) => m.tool_calls?.length),
  "assistant tool_calls echoed back",
)
assertTrue(orCalls >= 3, `made ${orCalls} provider calls (incl. title)`)
assertTrue(errors.length === 0, `no page errors (${errors.join("; ") || "none"})`)

await browser.close()
console.log(process.exitCode ? "E2E FAILED" : "E2E PASSED")
