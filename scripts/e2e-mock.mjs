// End-to-end smoke test: drives the real UI against a mocked OpenRouter +
// Tavily backend. Verifies streaming, the tool loop, artifact parsing,
// persistence and title generation. Needs `npm run preview` on :4173.
import { chromium } from "playwright"
import { mkdirSync, writeFileSync } from "node:fs"

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

// Sad-mood reply — the wrapped <emotion> tag split mid-stream; Pip must
// well up (tears are the only blue he ever wears) and the tag never renders
const sadResp = sse([
  chunk({ content: "<emo" }),
  chunk({
    content:
      "tion>sad</emotion>I'm sorry — that's genuinely sad news. Take a moment; I'm right here.",
  }),
  chunk({}, "stop", { prompt_tokens: 40, completion_tokens: 18, cost: 0.0002 }),
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
  permissions: ["clipboard-read", "clipboard-write"],
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
  const isSadNews =
    typeof lastUser?.content === "string" &&
    lastUser.content.includes("sad news")
  const hasToolResult = body.messages?.some((m) => m.role === "tool")
  const payload = isTitle
    ? titleResp
    : isSummary
      ? summaryResp
      : asksQuestions
        ? questionsResp
        : isSadNews
          ? sadResp
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

const assertTrue = (cond, msg) => {
  if (!cond) {
    console.error("ASSERT FAIL:", msg)
    process.exitCode = 1
  } else console.log("ok:", msg)
}

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

// --- the chat as Markdown a person can read ---
// Export/import is JSON because it round-trips; this is the other direction.
await page.getByLabel("Chat options").click()
await page.getByText("Copy as Markdown").click()
await page.getByText("Chat copied as Markdown").waitFor({ timeout: 5000 })
const md = await page.evaluate(() => navigator.clipboard.readText())
writeFileSync("shots/e2e-transcript.md", md) // for eyeballing the formatting
for (const [needle, what] of [
  ["# Espresso bean picks", "the chat title as the document title"],
  ["## You", "your turns"],
  ["## Assistant · Claude Sonnet 4.5", "the model that answered each turn"],
  ["*Searched “best espresso beans 2026”*", "the tool steps as the chips said them"],
  ["**Artefact — Espresso beans — quick guide** (Markdown)", "artefacts, labelled"],
  ["- **Fresh roast date** beats brand", "the artefact body in full"],
  ["$0.004", "what the reply cost"],
]) {
  assertTrue(md.includes(needle), `transcript carries ${what}`)
}
for (const [needle, what] of [
  ["<artifact", "artefact wire tags"],
  ["<thoughtful>", "hidden mood tags"],
  ["The search results mention", "the reasoning trace"],
]) {
  assertTrue(!md.includes(needle), `transcript leaves out ${what}`)
}
assertTrue(md.includes("*Thought for "), "transcript notes that it thought")

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

// --- sad mood: Pip visibly wells up (tears are his only blue paint) ---
await page.getByPlaceholder("Message Kiln…").fill("I have some sad news to share")
await page.getByLabel("Send").click()
await page.getByText("Take a moment; I'm right here.").waitFor({ timeout: 15000 })
if (await page.getByText("<emotion>sad").count()) {
  console.error("ASSERT FAIL: wrapped emotion tag leaked into the chat")
  process.exitCode = 1
} else console.log("ok: wrapped emotion tag stripped from the sad reply")
await page.waitForTimeout(1200) // tears well in over ~a second
let tearPx = 0
for (let i = 0; i < 8; i++) {
  const n = await page.evaluate(() => {
    const cv = document.querySelector("canvas[aria-hidden]")
    const g = cv?.getContext("2d")
    if (!cv || !g) return -1
    const d = g.getImageData(0, 0, cv.width, cv.height).data
    let count = 0
    for (let i = 0; i < d.length; i += 4)
      if (d[i + 3] > 120 && d[i + 2] > 180 && d[i + 2] > d[i] + 25) count++
    return count
  })
  tearPx = Math.max(tearPx, n)
  await page.waitForTimeout(350)
}
if (tearPx < 12) {
  console.error(`ASSERT FAIL: no visible tears while sad (${tearPx} blue px)`)
  process.exitCode = 1
} else console.log(`ok: sad mood wells up visible tears (${tearPx} blue px)`)

// --- find in chat, and a search result that lands on its message ---
// An installed PWA has no browser find-in-page, so this is the only way
// around a long conversation.
await page.getByPlaceholder("Message Kiln…").fill("/find espresso")
await page.getByLabel("Send").click()
await page.getByLabel("Find in chat").waitFor({ timeout: 5000 })
await page.waitForTimeout(600)
const findCount = page.locator("[data-ui='find-count']")
const firstMatch = await findCount.innerText()
assertTrue(
  Number(firstMatch.split("/")[1]) >= 2,
  `/find highlighted ${firstMatch.split("/")[1]} matches for "espresso"`,
)
assertTrue(
  (await page.evaluate(() => CSS.highlights?.size ?? -1)) >= 1,
  "matches painted through the CSS Custom Highlight API",
)
await page.getByLabel("Next match").click()
await page.waitForTimeout(500)
const nextMatch = await findCount.innerText()
assertTrue(
  nextMatch !== firstMatch,
  `stepping advances the current match (${firstMatch} → ${nextMatch})`,
)
await page.screenshot({ path: "shots/e2e-find.png" })
await page.getByLabel("Close find").click()
await page.waitForTimeout(300)
assertTrue(
  (await page.evaluate(() => CSS.highlights?.size ?? -1)) === 0,
  "closing the bar clears the paint",
)

// searching the sidebar and opening the hit must land ON the message
await page.getByLabel("Open menu").click()
await page.getByPlaceholder("Search chats").fill("Moka")
await page.waitForTimeout(800)
const drawer = page.locator("[data-slot='drawer-content']")
await drawer.getByText(/Moka pot/).first().waitFor({ timeout: 5000 })
console.log("ok: sidebar search shows a snippet of the matching message")
await drawer.getByText("Espresso bean picks").first().click()
await page.waitForTimeout(1200)
const landed = await page.evaluate(() => {
  const el = document.querySelector("[data-ui='app-main'] .overflow-y-auto")
  return {
    gap: Math.round(
      (el?.scrollHeight ?? 0) - (el?.scrollTop ?? 0) - (el?.clientHeight ?? 0),
    ),
    query: document.querySelector("[data-ui='find-bar'] input")?.value,
    flashed: !!document.querySelector(".find-flash"),
    jump: !!document.querySelector("[data-ui='jump-latest']"),
    search: location.search,
  }
})
assertTrue(landed.query === "Moka", "find bar opens primed with the searched text")
assertTrue(landed.flashed, "the matching message flashes so the eye finds it")
assertTrue(
  landed.gap > 300,
  `landed on the match, not at the bottom (${landed.gap}px of chat below it)`,
)
assertTrue(landed.jump, "jump-to-latest offered while scrolled up")
assertTrue(landed.search === "", "deep-link params cleaned out of the URL")
await page.screenshot({ path: "shots/e2e-find-landed.png" })
await page.locator("[data-ui='jump-latest']").click()
await page.waitForTimeout(1000)
assertTrue(
  await page.evaluate(() => {
    const el = document.querySelector("[data-ui='app-main'] .overflow-y-auto")
    return (
      (el?.scrollHeight ?? 0) - (el?.scrollTop ?? 0) - (el?.clientHeight ?? 0) < 4
    )
  }),
  "jump-to-latest returns to the newest message",
)

// --- drafts: an unsent message survives leaving the chat and a reload ---
// A long prompt typed on a phone is precious work; switching chats or iOS
// discarding the PWA in the background must not eat it.
const chatUrl = page.url()
const draftText = "Half-written thought about burr grinder alignment"
const composer = page.getByPlaceholder("Message Kiln…")
await composer.fill(draftText)
await page.locator('input[type="file"]').setInputFiles({
  name: "notes.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("fresh roast dates matter"),
})
await page.getByText("notes.txt").waitFor({ timeout: 5000 })
await page.waitForTimeout(1500) // idle debounce writes it to IndexedDB

// leaving for the new-chat screen must not carry the words across
await page.getByLabel("Open menu").click()
await drawer.getByText("New chat", { exact: true }).click()
await page.waitForTimeout(600)
assertTrue(
  (await composer.inputValue()) === "",
  "the previous chat's draft doesn't leak into a new chat",
)

// cold reload straight back into the chat: text and attachment both return
await page.goto(chatUrl, { waitUntil: "networkidle" })
await composer.waitFor({ timeout: 10000 })
await page.waitForTimeout(600)
assertTrue(
  (await composer.inputValue()) === draftText,
  "draft restored after a cold reload of the chat",
)
await page.getByText("notes.txt").waitFor({ timeout: 5000 })
console.log("ok: the draft's attachment came back with it")
await page.screenshot({ path: "shots/e2e-draft-restored.png" })

// the chat list says which chats are still holding unsent words
await page.getByLabel("Open menu").click()
await drawer
  .getByText(/Draft · Half-written thought/)
  .first()
  .waitFor({ timeout: 5000 })
console.log("ok: the chat list flags the unsent draft")

// a second conversation, to prove drafts belong to one chat each
await drawer.getByText("New chat", { exact: true }).click()
await page.waitForTimeout(400)
await composer.fill("Tell me about grinders")
await page.getByLabel("Send").click()
await page.getByText("Want tasting notes for any of these?").last().waitFor({ timeout: 20000 })
await page.waitForTimeout(2500) // let the title call land before renaming
await composer.fill("/title Grinder talk")
await page.getByLabel("Send").click()
await page.getByRole("heading", { name: "Grinder talk" }).waitFor({ timeout: 5000 })
const draftB = "notes meant only for the second chat"
await composer.fill(draftB)
await page.waitForTimeout(1500)

// switching between two open chats: each gets its own words back
await page.getByLabel("Open menu").click()
await drawer.getByText("Espresso bean picks").first().click()
await page.waitForTimeout(800)
assertTrue(
  (await composer.inputValue()) === draftText,
  "switching chats restores that chat's draft, not the one you left",
)
await page.getByText("notes.txt").waitFor({ timeout: 5000 })
await page.getByLabel("Open menu").click()
await drawer.getByText("Grinder talk").first().click()
await page.waitForTimeout(800)
assertTrue(
  (await composer.inputValue()) === draftB,
  "and back again — the second chat's draft is intact",
)
assertTrue(
  (await page.getByText("notes.txt").count()) === 0,
  "attachments stay with their own chat's draft",
)

// sending clears that chat's draft, and only that one
await page.getByLabel("Send").click()
await page.waitForTimeout(1500)
assertTrue((await composer.inputValue()) === "", "sending empties the composer")
await page.getByLabel("Open menu").click()
await page.waitForTimeout(600)
assertTrue(
  (await drawer.getByText(/Draft · notes meant only/).count()) === 0,
  "sending clears the stored draft",
)
assertTrue(
  (await drawer.getByText(/Draft · Half-written thought/).count()) === 1,
  "the other chat's draft is still waiting",
)
await page.keyboard.press("Escape")
await page.waitForTimeout(600)

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
