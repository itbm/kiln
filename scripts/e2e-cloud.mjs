// End-to-end test of cloud runtime: drives the real UI and the real cloud
// runner (server/cloud.mjs) against a dripping mock provider, and proves the
// promise the feature makes — close the app mid-reply, reopen, and the
// finished reply is waiting on the device.
//
// Needs `npm run preview` on :4173. Starts its own mock provider (:9331)
// and the cloud runner (:8090 — the port the preview proxy targets).
import { chromium } from "playwright"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"

const BASE = "http://localhost:4173"
const MOCK_PORT = 9331
const CLOUD_PORT = 8090
const CLOUD = `http://127.0.0.1:${CLOUD_PORT}/api/cloud`
mkdirSync("shots", { recursive: true })

const sse = (events) =>
  events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") +
  "\n\ndata: [DONE]\n\n"
const chunk = (delta, finish = null, usage = null) => ({
  id: "gen-1",
  choices: [{ delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
})

/** SSE-drip `events` at `ms` intervals, then [DONE]. */
function drip(res, events, ms) {
  let i = 0
  const t = setInterval(() => {
    if (i < events.length) res.write(`data: ${JSON.stringify(events[i++])}\n\n`)
    else {
      clearInterval(t)
      res.end("data: [DONE]\n\n")
    }
  }, ms)
  res.on("close", () => clearInterval(t))
}

// ---- mock upstream (OpenRouter + Tavily shapes) — only the cloud runner
// talks to this; the browser never sees it ----
const mock = createServer(async (req, res) => {
  let body = ""
  for await (const c of req) body += c
  if (req.url === "/search") {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(
      JSON.stringify({
        answer: "The cloud runner searched this for you.",
        results: [{ title: "Result", url: "https://example.com", content: "…" }],
      }),
    )
  }
  if (req.url === "/api/v1/chat/completions") {
    const parsed = JSON.parse(body)
    const firstUser = parsed.messages.find((m) => m.role === "user")
    const marker = typeof firstUser?.content === "string" ? firstUser.content : ""
    const hasToolResult = parsed.messages.some((m) => m.role === "tool")
    res.writeHead(200, { "content-type": "text/event-stream" })

    if (/marathon/.test(marker)) {
      // long drip with no tool round — for the Stop test
      const events = [
        ...Array.from({ length: 100 }, (_, i) => chunk({ content: `step ${i + 1} ` })),
        chunk({}, "stop", { prompt_tokens: 50, completion_tokens: 100, cost: 0.005 }),
      ]
      return drip(res, events, 300)
    }
    if (!hasToolResult) {
      // round 1: ask for a web search (executed server-side)
      return res.end(
        sse([
          chunk({ role: "assistant", content: "" }),
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "web_search", arguments: '{"query":"cloud test"}' },
              },
            ],
          }),
          chunk({}, "tool_calls", { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 }),
        ]),
      )
    }
    // round 2: drip slowly enough that the page closes mid-reply
    const words = "Here is the reply streamed by the cloud runner while the app was closed.".split(" ")
    const events = [
      chunk({ reasoning: "Reading the search results. " }),
      ...words.map((w) => chunk({ content: w + " " })),
      chunk({}, "stop", {
        prompt_tokens: 200,
        completion_tokens: 50,
        cost: 0.003,
        completion_tokens_details: { reasoning_tokens: 5 },
      }),
    ]
    return drip(res, events, 250)
  }
  res.writeHead(404).end()
})
await new Promise((r) => mock.listen(MOCK_PORT, r))

// ---- the real cloud runner, pointed at the mock ----
const runner = spawn("node", ["server/cloud.mjs"], {
  env: {
    ...process.env,
    PORT: String(CLOUD_PORT),
    KILN_OPENROUTER_BASE: `http://127.0.0.1:${MOCK_PORT}/api/v1`,
    KILN_TAVILY_BASE: `http://127.0.0.1:${MOCK_PORT}`,
  },
  stdio: ["ignore", "inherit", "inherit"],
})
const cleanup = () => {
  runner.kill()
  mock.close()
}
process.on("exit", cleanup)

for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${CLOUD}/health`)).ok) break
  } catch {
    /* not up yet */
  }
  if (i > 50) {
    console.error("cloud runner never came up on :8090")
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 100))
}
try {
  await fetch(BASE)
} catch {
  console.error("preview server not running — start `npm run preview` first")
  process.exit(1)
}

const errors = []
let fails = 0
const check = (cond, msg) => {
  if (cond) console.log("ok:", msg)
  else {
    console.error("ASSERT FAIL:", msg)
    fails++
  }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
})
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})
// keys + a fresh models cache so the composer is ready without any network
// (first run only — later navigations must keep what the app itself saved,
// e.g. the remembered Local/Cloud choice)
await ctx.addInitScript(() => {
  if (localStorage.getItem("amber-settings")) return
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
        ctx: 200000,
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
// title generation runs on-device — intercept it (the chat itself must NOT
// hit this route: cloud turns leave the browser entirely)
let browserChatCalls = 0
await ctx.route("**/openrouter.ai/**", (route) => {
  const url = route.request().url()
  if (url.includes("/chat/completions")) {
    browserChatCalls++
    const body = JSON.parse(route.request().postData() ?? "{}")
    const isTitle = (body.messages?.[0]?.content ?? "").includes("short titles")
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sse([
        chunk({ content: isTitle ? "Cloud catch-up test" : "unexpected" }),
        chunk({}, "stop"),
      ]),
    })
  }
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: '{"data":[]}',
  })
})

const readLastAssistant = (page) =>
  page.evaluate(async () => {
    const req = indexedDB.open("amber")
    const idb = await new Promise((res) => (req.onsuccess = () => res(req.result)))
    const all = await new Promise((res) => {
      const r = idb.transaction("messages", "readonly").objectStore("messages").getAll()
      r.onsuccess = () => res(r.result)
    })
    const chatId = location.pathname.split("/").pop()
    const mine = all
      .filter((me) => me.chatId === chatId && me.role === "assistant")
      .sort((a, b) => a.createdAt - b.createdAt)
    const m = mine[mine.length - 1]
    return m
      ? {
          status: m.status,
          cloudJobId: m.cloudJobId ?? null,
          content: m.content,
          steps: (m.steps ?? []).map((s) => s.name),
          cost: m.usage?.cost ?? null,
          reasoning: m.reasoning ?? "",
        }
      : null
  })

let page = await ctx.newPage()
page.on("pageerror", (e) => errors.push(`A: ${e.message}`))
await page.goto(`${BASE}/`, { waitUntil: "networkidle" })

// (a function: `page` is reassigned when the app is reopened later)
const pill = () => page.getByLabel("Where replies generate")

// --- the pill appears (health probe succeeded) and Cloud can be chosen ---
await pill().waitFor({ timeout: 10000 })
check((await pill().innerText()).includes("Local"), "runtime pill defaults to Local")
await pill().click()
const cloudItem = page
  .getByRole("menuitem")
  .filter({ hasText: "Your server runs the reply" })
await cloudItem.waitFor({ timeout: 5000 })
await page.screenshot({ path: "shots/e2e-cloud-menu.png" })
await cloudItem.click()
check((await pill().innerText()).includes("Cloud"), "pill switches to Cloud")

// --- ghost mode has no cloud: the pill hides while temporary is on ---
await page.getByLabel("More options").click()
await page.getByText("Temporary chat").click()
check((await pill().count()) === 0, "pill hidden in a temporary chat")
await page.getByLabel("More options").click()
await page.getByText("Disable temporary chat").click()
await pill().waitFor({ timeout: 5000 })
check(true, "pill returns when temporary is off")

// --- send, watch the server-side tool round + live stream, then kill ---
await page.getByPlaceholder("Message Kiln…").fill("Please research this")
await page.getByLabel("Send").click()
await page.getByText("Searched “cloud test”").waitFor({ timeout: 15000 })
console.log("ok: server-side web search surfaced as a tool chip")
await page.getByText(/Here is the reply/).waitFor({ timeout: 15000 })
console.log("ok: cloud reply streams into the open app")
const chatUrl = page.url()
const midFlight = await readLastAssistant(page)
check(midFlight?.status === "streaming", "reply still mid-flight at kill time")
check(!!midFlight?.cloudJobId, "cloudJobId persisted before the kill")
const jobId = midFlight.cloudJobId
await page.screenshot({ path: "shots/e2e-cloud-streaming.png" })
await page.close() // the app is gone; the turn is not

// --- the runner finishes alone; the journal holds the whole reply ---
const drained = await (async () => {
  const res = await fetch(`${CLOUD}/jobs/${jobId}/events?from=0`)
  let text = ""
  for await (const c of res.body) text += Buffer.from(c).toString()
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5)))
})()
check(
  drained.some((e) => e.t === "final" && e.status === "done"),
  "runner finished the turn with the app closed",
)
const journalText = drained
  .filter((e) => e.t === "text")
  .map((e) => e.x)
  .join("")
check(journalText.includes("was closed."), "journal holds the full reply text")

// --- reopen: the app catches up, stores the reply, and tidies the server ---
page = await ctx.newPage()
page.on("pageerror", (e) => errors.push(`B: ${e.message}`))
await page.goto(chatUrl, { waitUntil: "networkidle" })
await page
  .getByText("Here is the reply streamed by the cloud runner while the app was closed.")
  .waitFor({ timeout: 15000 })
console.log("ok: reopening catches up on the finished reply")
await page.getByText("Searched “cloud test”").waitFor({ timeout: 5000 })
console.log("ok: tool chip survived the round trip")
await page.getByText("$0.004", { exact: true }).waitFor({ timeout: 10000 })
console.log("ok: usage summed across both server-side rounds")
await page
  .getByRole("heading", { name: "Cloud catch-up test" })
  .waitFor({ timeout: 10000 })
console.log("ok: title generated on-device after catch-up")
for (let i = 0; i < 40; i++) {
  const done = await readLastAssistant(page)
  if (done?.status === "done" && !done.cloudJobId) break
  await page.waitForTimeout(250)
}
const done = await readLastAssistant(page)
check(done?.status === "done", `message finalised as done (${done?.status})`)
check(done?.cloudJobId === null, "cloudJobId cleared after collection")
check(done?.reasoning.includes("Reading the search results"), "reasoning trace collected")
let gone = false
for (let i = 0; i < 20 && !gone; i++) {
  gone = (await fetch(`${CLOUD}/jobs/${jobId}/events?from=0`)).status === 404
  if (!gone) await new Promise((r) => setTimeout(r, 250))
}
check(gone, "server forgot the job once the device had the reply")
await page.screenshot({ path: "shots/e2e-cloud-caught-up.png" })

// --- a second chat remembers Cloud, and Stop reaches the server ---
await page.getByLabel("Open menu").click()
await page
  .locator("[data-slot='drawer-content']")
  .getByText("New chat", { exact: true })
  .click()
await page.waitForTimeout(600)
check(
  (await pill().innerText()).includes("Cloud"),
  "new chat remembers the Cloud choice",
)
await page.getByPlaceholder("Message Kiln…").fill("Run a marathon")
await page.getByLabel("Send").click()
await page.getByText(/step 3/).waitFor({ timeout: 20000 })
await page.getByLabel("Stop").click()
await page.getByLabel("Send").waitFor({ timeout: 15000 })
console.log("ok: stop ended the stream in the UI")
let stopped
for (let i = 0; i < 40; i++) {
  stopped = await readLastAssistant(page)
  if (stopped?.status === "stopped" && !stopped.cloudJobId) break
  await page.waitForTimeout(250)
}
check(stopped?.status === "stopped", `stopped reply recorded (${stopped?.status})`)
check(/step \d/.test(stopped?.content ?? ""), "partial output kept on stop")
check(stopped?.cloudJobId === null, "stopped job pointer cleared")
const jobs = (await (await fetch(`${CLOUD}/health`)).json()).jobs
check(jobs === 0, `no jobs left on the server (${jobs})`)

// --- stopped reply survives a reload untouched ---
await page.reload({ waitUntil: "networkidle" })
await page.getByText(/step \d/).first().waitFor({ timeout: 10000 })
const reloaded = await readLastAssistant(page)
check(reloaded?.status === "stopped", "stopped reply intact after reload")

check(browserChatCalls <= 2 && browserChatCalls >= 1, `browser only made title calls (${browserChatCalls})`)
check(errors.length === 0, `no page errors (${errors.join("; ") || "none"})`)

await browser.close()
cleanup()
console.log(fails ? "E2E-CLOUD FAILED" : "E2E-CLOUD PASSED")
process.exit(fails ? 1 : 0)
