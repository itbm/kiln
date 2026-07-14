// End-to-end smoke test for agent sessions (the Code tab): drives the real
// UI against a MOCKED kiln-agentd API. Covers the unconfigured/configured
// empty states, Settings → Agent runner (journal key generation), the
// new-task composer (per-session secrets in the create body, deny-all
// default), the session view (steps / diff / PR cards), and the sidebar
// exclusion of agent chats. Needs `npm run preview` on :4173.
import { chromium } from "playwright"

const BASE = "http://localhost:4173"
const pass = (m) => console.log("ok:", m)
const fail = (m) => {
  console.error("FAIL:", m)
  process.exitCode = 1
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
})
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await ctx.newPage()
const errors = []
page.on("pageerror", (e) => errors.push(String(e)))

// ---- 1. unconfigured empty state --------------------------------------
await page.goto(BASE + "/code")
await page.waitForSelector("text=Code with an agent", { timeout: 10_000 })
pass("unconfigured empty state renders")
await page.click("text=Set up the runner")
await page.waitForSelector("text=Agent runner", { timeout: 10_000 })
pass("empty-state CTA lands on Settings → Agent runner")

// ---- 2. settings section fields ----------------------------------------
await page.waitForSelector("text=Runner token")
await page.waitForSelector("text=GitHub token (fine-grained PAT)")
await page.getByRole("button", { name: "Generate", exact: true }).click()
const jk = await page.evaluate(
  () => JSON.parse(localStorage.getItem("amber-settings")).state.agentJournalKey,
)
if (/^[0-9a-f]{64}$/.test(jk)) pass("journal key generated (64 hex)")
else fail("journal key malformed: " + jk)

// configure runner + keys via the store (as a user who pasted them)
await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem("amber-settings"))
  Object.assign(raw.state, {
    agentRunnerToken: "test-runner-token-0123456789",
    agentGithubToken: "github_pat_test_0123456789",
    openrouterKey: "sk-or-test-0123456789",
    lastAgentModel: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
  })
  localStorage.setItem("amber-settings", JSON.stringify(raw))
})

// ---- 3. mock the runner API --------------------------------------------
let createdBody = null
await ctx.route("**/agent/v1/sessions", async (route) => {
  createdBody = route.request().postDataJSON()
  await route.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify({
      id: "sess-test-1",
      state: "provisioning",
      taskBranch: "kiln/add-a-health-badge-abc123",
      events: "/agent/v1/sessions/sess-test-1/events",
    }),
  })
})
await ctx.route("**/agent/v1/sessions/sess-test-1", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      id: "sess-test-1",
      state: "running",
      repo: "itbm/kiln",
      baseBranch: "main",
      taskBranch: "kiln/add-a-health-badge-abc123",
      createdAt: Date.now(),
      latestSeq: 3,
    }),
  }),
)

// ---- 4. composer → create session --------------------------------------
await page.goto(BASE + "/code")
await page.waitForSelector("text=Ship something")
pass("configured empty state renders")
await page.click("text=New task")
await page.waitForSelector("text=New coding task")
await page.fill('input[placeholder="owner/name"]', "itbm/kiln")
await page.fill("textarea", "Add a health badge to the README")
const startBtn = page.locator("button", { hasText: "Start task" })
await startBtn.click()
await page.waitForURL("**/code/**", { timeout: 10_000 })
pass("session created and navigated to session view")
if (createdBody?.provider?.token === "sk-or-test-0123456789") pass("provider key sent per session")
else fail("provider token missing from create body")
if (createdBody?.github?.token === "github_pat_test_0123456789") pass("github PAT sent per session")
else fail("github token missing")
if (createdBody?.options?.network?.policy === "deny-all") pass("deny-all network default")
else fail("unexpected network policy: " + JSON.stringify(createdBody?.options))

await page.waitForSelector("text=itbm/kiln · kiln/add-a-health-badge-abc123")
pass("session header shows repo · branch")
await page.waitForSelector("text=Add a health badge to the README")
pass("task shown as user message")

// WS will fail against the mock (no ws route) → offline chip; the session
// probe (mocked above) reports running, so the view stays live.
await page.waitForSelector('textarea[placeholder="Steer the agent…"]', { timeout: 10_000 })
pass("live steering composer visible")

// ---- 5. timeline rendering of persisted run state -----------------------
// (the WS folding path writes exactly these shapes; write them via
// IndexedDB and verify the timeline renders steps + cards from storage)
const chatId = page.url().split("/code/")[1]
await page.evaluate(
  async ([chatId]) => {
    const openReq = indexedDB.open("amber")
    const idb = await new Promise((res, rej) => {
      openReq.onsuccess = () => res(openReq.result)
      openReq.onerror = () => rej(openReq.error)
    })
    const tx = idb.transaction(["messages", "chats"], "readwrite")
    const msgs = tx.objectStore("messages")
    const all = await new Promise((res) => {
      const r = msgs.getAll()
      r.onsuccess = () => res(r.result)
    })
    const assistant = all.find((m) => m.chatId === chatId && m.role === "assistant")
    assistant.steps = [
      { id: "b1", name: "bootstrap", args: {}, result: "bootstrap ok", status: "done" },
      { id: "t1", name: "Bash", args: { command: "npm test" }, result: "42 passing", status: "done" },
    ]
    assistant.content = "All tests pass. Opening the PR now."
    assistant.agent = {
      prUrl: "https://github.com/itbm/kiln/pull/99",
      diff: { stat: " README.md | 2 +-\n 1 file changed", patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new" },
    }
    msgs.put(assistant)
    tx.commit?.()
    idb.close()
  },
  [chatId],
)
// a raw IDB write doesn't ping Dexie's liveQuery — reload to render from storage
await page.reload()
await page.waitForSelector("text=$ npm test", { timeout: 10_000 })
pass("tool step chip renders (Bash)")
await page.waitForSelector("text=Cloned repository & created branch")
pass("bootstrap step chip renders")
await page.waitForSelector("text=Pull request ready")
pass("PR card renders")
await page.waitForSelector("text=Changes")
pass("diff card renders")
await page.click("text=Changes")
await page.waitForSelector("text=1 file changed")
pass("diff card expands with stat")

// ---- 6. sidebar: Code nav present, agent chat excluded from chat list ---
await page.goto(BASE + "/")
await page.click('button[aria-label="Open menu"]')
await page.waitForSelector("text=Code")
pass("Code nav item in sidebar")
const inChatList = await page.locator("text=Add a health badge to the README").count()
if (inChatList === 0) pass("agent session excluded from chat list")
else fail("agent chat leaked into the regular chat list")

if (errors.length) fail("page errors: " + errors.join(" | "))
else pass("no page errors")

await browser.close()
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED")
