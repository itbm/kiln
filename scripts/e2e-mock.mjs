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

const chunk = (delta, finish = null) => ({
  id: "gen-1",
  choices: [{ delta, finish_reason: finish }],
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
  chunk({}, "tool_calls"),
])

// Round 2: reasoning + prose + a markdown artifact
const round2 = sse([
  chunk({ reasoning: "The search results mention three roasters. " }),
  chunk({ reasoning: "I'll summarise and produce a short guide artifact." }),
  chunk({ content: "Based on what I found, here's a quick guide:\n\n" }),
  chunk({
    content:
      '<artifact identifier="espresso-guide" type="text/markdown" title="Espresso beans — quick guide">\n# Espresso beans\n\n',
  }),
  chunk({ content: "- **Fresh roast date** beats brand\n- Medium-dark for milk drinks\n" }),
  chunk({ content: "</artifact>\n\nWant tasting notes for any of these?" }),
  chunk({}, "stop"),
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
await page.getByPlaceholder("Message Kiln…").fill("What espresso beans should I buy?")
await page.getByLabel("Send").click()

// tool chip appears
await page.getByText("Searched “best espresso beans 2026”").waitFor({ timeout: 10000 })
// artifact card appears
await page.getByText("Espresso beans — quick guide").waitFor({ timeout: 10000 })
// generated title lands in the header
await page.getByRole("heading", { name: "Espresso bean picks" }).waitFor({ timeout: 10000 })
await page.waitForTimeout(400)
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

// --- regenerate keeps the old attempt as a version ---
await page.getByLabel("Regenerate").click()
await page.getByText("2/2").waitFor({ timeout: 15000 })
await page.getByLabel("Previous version").click()
await page.getByText("1/2").waitFor({ timeout: 5000 })
await page.getByLabel("Next version").click()
await page.getByText("2/2").waitFor({ timeout: 5000 })
console.log("ok: regenerate created version 2/2 and switcher works")
await page.screenshot({ path: "shots/e2e-versions.png" })

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
