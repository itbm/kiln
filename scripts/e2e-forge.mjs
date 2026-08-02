// End-to-end test of the coding runtime: drives the real UI and the real
// forge (server/forge) against a mock sbx daemon on a real Unix socket and a
// mock kiln-agent, plus a mocked api.github.com.
//
// What this proves: the journal protocol, the SSE replay and catch-up, the
// question round-trip, multi-turn resume, workspace rebuild after the sandbox
// dies, and that Kiln's own state never reaches a commit.
//
// What it deliberately does NOT prove: anything about sbx itself. There is no
// KVM here. Every sbx assumption lives behind server/forge/sandbox.mjs, and
// the Phase 0 spike against a real daemon is still required before trusting
// this on a host.
//
// Needs `npm run preview` on :4173. Starts its own mock daemon, mock agent
// and forge (:8091 — the port the preview proxy targets).
import { chromium } from "playwright"
import { createServer } from "node:http"
import { spawn, execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BASE = "http://localhost:4173"
const FORGE_PORT = 8091
const AGENT_PORT = 19790
const root = mkdtempSync(join(tmpdir(), "kiln-forge-e2e-"))
const SOCK = join(root, "sandboxd.sock")
const WS_ROOT = join(root, "workspaces")
// Must sit where KILN_GITHUB_BASE + owner/name resolves to.
const ORIGIN = join(root, "acct", "demo.git")
mkdirSync(WS_ROOT, { recursive: true })
mkdirSync("shots", { recursive: true })

let pass = 0
let fail = 0
const ok = (n) => {
  pass++
  console.log(`ok: ${n}`)
}
const bad = (n, d) => {
  fail++
  console.log(`FAIL: ${n}\n      ${d}`)
}

/* ---------- a real git remote to push into ---------- */
const git = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
  })
mkdirSync(join(root, "acct"), { recursive: true })
git(["init", "--bare", "-b", "main", ORIGIN], root)
{
  const seed = join(root, "seed")
  mkdirSync(seed)
  git(["init", "-b", "main"], seed)
  execFileSync("sh", ["-c", `echo "# demo" > ${join(seed, "README.md")}`])
  git(["add", "-A"], seed)
  git(["commit", "-m", "seed"], seed)
  git(["remote", "add", "origin", ORIGIN], seed)
  git(["push", "-u", "origin", "main"], seed)
}

/* ---------- mock kiln-agent ----------
   Stands in for the resident Claude Code session. Emits the same message
   shapes server/forge/events.mjs maps, so the translation layer is exercised
   for real. */
let agentGeneration = 0
let killAgent = false
const runs = new Map()
// The forge mints a fresh per-sandbox token and passes it in create env; the
// mock daemon captures it so the agent can accept exactly that.
let agentToken = ""
let scenario = "normal"

const agent = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  if (killAgent && url.pathname !== "/__revive") {
    res.writeHead(503)
    return res.end()
  }
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({ ok: true, sessionId: "sess-1" }))
  }
  if (req.headers.authorization !== `Bearer ${agentToken}`) {
    res.writeHead(401)
    return res.end()
  }
  let body = ""
  for await (const c of req) body += c

  if (url.pathname === "/turn") {
    const parsed = JSON.parse(body || "{}")
    const runId = `run-${runs.size + 1}`
    const run = { entries: [], waiters: new Set(), done: false, pending: null }
    runs.set(runId, run)
    void driveTurn(run, parsed)
    res.writeHead(201, { "content-type": "application/json" })
    return res.end(JSON.stringify({ runId }))
  }

  if (url.pathname === "/events") {
    const run = runs.get(url.searchParams.get("run"))
    if (!run) {
      res.writeHead(404)
      return res.end()
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
    for (const e of run.entries) res.write(`data: ${JSON.stringify(e)}\n\n`)
    if (run.done) {
      res.write(`data: ${JSON.stringify({ kilnEnd: true })}\n\n`)
      return res.end()
    }
    run.waiters.add(res)
    req.on("close", () => run.waiters.delete(res))
    return
  }

  if (url.pathname === "/reply") {
    const { requestId, decision } = JSON.parse(body || "{}")
    const run = [...runs.values()].find((r) => r.pending?.requestId === requestId)
    if (run) {
      run.pending.resolve(decision)
      run.pending = null
    }
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({ ok: true }))
  }

  if (url.pathname === "/interrupt") {
    for (const r of runs.values())
      if (!r.done) {
        push(r, { type: "assistant", content: [{ type: "text", text: "\n(stopped)" }] })
        finish(r)
      }
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({ ok: true }))
  }

  res.writeHead(404)
  res.end()
})

function push(run, msg) {
  run.entries.push(msg)
  const frame = `data: ${JSON.stringify(msg)}\n\n`
  for (const w of run.waiters) if (!w.destroyed) w.write(frame)
}
function finish(run) {
  run.done = true
  const frame = `data: ${JSON.stringify({ kilnEnd: true })}\n\n`
  for (const w of run.waiters) {
    if (!w.destroyed) w.write(frame)
    w.end()
  }
  run.waiters.clear()
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function driveTurn(run, body) {
  agentGeneration++
  push(run, { type: "system", data: { session_id: "sess-1" } })
  // Prove the forge forwards resume across an agent restart.
  if (body.resume) push(run, { type: "assistant", content: [{ type: "text", text: `Resumed ${body.resume}. ` }] })
  push(run, { type: "assistant", content: [{ type: "text", text: "Reading the repository. " }] })
  await sleep(120)
  push(run, {
    type: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } }],
  })
  push(run, { type: "result", tool_use_id: "t1", content: [{ type: "text", text: "# demo" }] })

  if (scenario === "asks") {
    const requestId = "req-1"
    push(run, { type: "permission_request", requestId, toolName: "Bash", input: { command: "rm -rf build" } })
    const decision = await new Promise((resolve) => {
      run.pending = { requestId, resolve }
    })
    push(run, {
      type: "assistant",
      content: [{ type: "text", text: decision === "allow" ? "Permission granted. " : "Skipping that. " }],
    })
  }

  if (scenario === "claudeDir") {
    // Claude Code writes this into every project it touches. It must be
    // skipped silently — failing a turn over it would make the feature
    // unusable — which is what .git/info/exclude is for.
    const wsDir = join(lastWorkspace, "repo")
    mkdirSync(join(wsDir, ".claude"), { recursive: true })
    execFileSync("sh", ["-c", `echo local > ${join(wsDir, ".claude", "settings.local.json")}`])
  }

  if (scenario === "leak") {
    // Kiln's own state *inside* the tree, which no ignore rule covers. Only
    // the staged assertion in commitAndPush stands between this and a push.
    const wsDir = join(lastWorkspace, "repo")
    mkdirSync(join(wsDir, ".kiln"), { recursive: true })
    execFileSync("sh", ["-c", `echo transcript > ${join(wsDir, ".kiln", "journal.ndjson")}`])
  }

  // Real file change so there is something to commit and push.
  const wsDir = join(lastWorkspace, "repo")
  if (existsSync(wsDir))
    execFileSync("sh", ["-c", `echo "changed by agent" >> ${join(wsDir, "README.md")}`])

  push(run, { type: "assistant", content: [{ type: "text", text: "Done." }] })
  push(run, {
    type: "result",
    usage: { input_tokens: 1200, output_tokens: 300 },
    total_cost_usd: 0.004,
    duration_ms: 900,
  })
  finish(run)
}

/* ---------- mock sbx daemon on a real Unix socket ---------- */
/** the workspace path of the most recently created sandbox */
let lastWorkspace = ""
let sandboxes = new Map()
let createCount = 0
const daemon = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  let body = ""
  for await (const c of req) body += c
  const json = (status, obj) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(obj))
  }
  if (url.pathname === "/daemon/health") return json(200, { ok: true })
  if (url.pathname === "/daemon/info") return json(200, { version: "mock-0.34.0" })
  if (url.pathname === "/sandbox" && req.method === "POST") {
    const b = JSON.parse(body || "{}")
    createCount++
    // The forge must not put credentials in create-time env — that is what
    // would reach the daemon's on-disk metadata.
    const envStr = JSON.stringify(b.env ?? {})
    if (/github_pat_|sk-or-/.test(envStr))
      bad("secrets kept out of sbx create env", `env carried a credential: ${envStr}`)
    lastWorkspace = b.workspace
    // Creating a sandbox is what starts kiln-agent inside it.
    killAgent = false
    agentToken = b.env?.KILN_AGENT_TOKEN ?? ""
    if (!agentToken) bad("forge passes a bootstrap agent token", "env had none")
    sandboxes.set(b.name, { name: b.name, workspace: b.workspace })
    return json(201, { name: b.name, id: b.name })
  }
  const m = /^\/sandbox\/([^/]+)(\/ports|\/stop|\/exec)?$/.exec(url.pathname)
  if (m) {
    const name = decodeURIComponent(m[1])
    if (req.method === "GET" && !m[2])
      return sandboxes.has(name) ? json(200, sandboxes.get(name)) : json(404, {})
    if (req.method === "POST" && m[2] === "/ports")
      return json(200, [{ sandbox_port: "8790", host_port: String(AGENT_PORT), host_ip: "127.0.0.1" }])
    if (req.method === "DELETE" && !m[2]) {
      sandboxes.delete(name)
      res.writeHead(204)
      return res.end()
    }
  }
  json(404, {})
})

/* ---------- boot ---------- */
await new Promise((r) => daemon.listen(SOCK, r))
await new Promise((r) => agent.listen(AGENT_PORT, "127.0.0.1", r))

const forge = spawn(process.execPath, ["server/forge/index.mjs"], {
  env: {
    ...process.env,
    PORT: String(FORGE_PORT),
    KILN_WORKSPACE_ROOT: WS_ROOT,
    KILN_SBX_SOCKET: SOCK,
    KILN_SBX_TOKEN: "sbx-token-e2e",
    KILN_AGENT_HOST: "127.0.0.1",
    KILN_AGENT_PORT: "8790",
    KILN_ALLOW_PLAIN_FS: "1",
    // clone from the local bare repo rather than github.com
    KILN_GITHUB_BASE: root,
  },
  stdio: ["ignore", "pipe", "pipe"],
})
forge.stderr.on("data", (d) => process.stderr.write(`[forge] ${d}`))
await new Promise((r) => setTimeout(r, 700))

const cleanup = () => {
  try {
    forge.kill()
  } catch {}
  try {
    daemon.close()
    agent.close()
  } catch {}
  rmSync(root, { recursive: true, force: true })
}
process.on("exit", cleanup)

/* ---------- browser ---------- */
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
const pageErrors = []
page.on("pageerror", (e) => pageErrors.push(e.message))

await page.addInitScript(() => {
  if (!localStorage.getItem("amber-settings"))
    localStorage.setItem(
      "amber-settings",
      JSON.stringify({
        version: 2,
        state: {
          githubToken: "github_pat_e2e",
          openrouterKey: "sk-or-e2e",
          lastModel: { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" },
          generateTitles: false,
        },
      }),
    )
  localStorage.setItem(
    "amber-models-cache",
    JSON.stringify({
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
          tools: true,
        },
      ],
    }),
  )
})

await page.route("https://api.github.com/**", async (route) => {
  const u = new URL(route.request().url())
  if (u.pathname === "/user/repos")
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          name: "demo",
          full_name: "acct/demo",
          owner: { login: "acct" },
          default_branch: "main",
          private: false,
          description: "the demo repo",
          pushed_at: "2026-07-20T00:00:00Z",
        },
      ]),
    })
  if (/\/branches$/.test(u.pathname))
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: "main", protected: false }]),
    })
  return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
})

// The clone must come from the local bare repo, not github.com.
await page.addInitScript(() => {})

console.log(`\n--- forge e2e (workspaces: ${WS_ROOT}) ---`)

// Health first: if this is wrong, every UI assertion below is noise.
const health = await fetch(`http://127.0.0.1:${FORGE_PORT}/api/forge/health`)
  .then((r) => r.json())
  .catch((e) => ({ ok: false, error: e.message }))
if (health.ok) ok(`forge reports healthy (sbx ${health.sbx?.version})`)
else bad("forge reports healthy", JSON.stringify(health))

await page.goto(BASE)
await page.waitForTimeout(900)

/** On a phone viewport the sidebar lives behind the menu button. */
const openSidebar = async () => {
  const menu = page.getByRole("button", { name: "Open menu" })
  if (await menu.count()) await menu.first().click()
  await page.waitForTimeout(350)
}

// ---- 1. the entry point appears only when the forge is reachable ----
await openSidebar()
const entry = page.getByRole("button", { name: "New code chat" })
if (await entry.count()) ok("Code chat entry point appears when the forge is up")
else bad("Code chat entry point appears", "button not found in the sidebar")

// ---- 2. repo picker → branch picker → chat ----
await entry.first().click()
await page.getByPlaceholder("Search repositories…").waitFor({ timeout: 15000 })
await page.screenshot({ path: "shots/e2e-forge-repo-picker.png" })
await page.locator("[data-slot=command-item]").first().click()
await page.getByPlaceholder("Search branches…").waitFor({ timeout: 15000 })
await page.screenshot({ path: "shots/e2e-forge-branch-picker.png" })
await page.locator("[data-slot=command-item]").filter({ hasText: "main" }).first().click()
await page.waitForTimeout(900)

const subtitle = (await page.locator("[data-ui=header-sub]").textContent()) ?? ""
if (/acct\/demo/.test(subtitle) && /main →/.test(subtitle))
  ok(`header shows the repo and branch pair (${subtitle.trim()})`)
else bad("header shows the repo and branch pair", `subtitle was: ${subtitle}`)

// ---- 3. a coding turn streams, with tool steps ----
const composer = page.locator("textarea").first()
await composer.fill("Add a line to the README")
await page.waitForTimeout(150)
await page.getByRole("button", { name: /send/i }).first().click()
await page.waitForTimeout(1200)
await page.screenshot({ path: "shots/e2e-forge-streaming.png" })

await page.waitForFunction(
  () => /Done\./.test(document.body.innerText),
  { timeout: 30000 },
)
ok("the coding turn streamed to completion")

const bodyText = await page.locator("body").innerText()
if (/Read/.test(bodyText)) ok("tool steps render in the transcript")
else bad("tool steps render", "no Read step found")

// ---- 4. the branch card, and a real push ----
await page.waitForSelector("[data-ui=branch-card]", { timeout: 20000 })
const cardText = (await page.locator("[data-ui=branch-card]").innerText()) ?? ""
if (/kiln\//.test(cardText) && /file/.test(cardText))
  ok(`branch card shows the pushed branch (${cardText.split("\n")[0]})`)
else bad("branch card shows the pushed branch", `card was: ${cardText}`)
await page.screenshot({ path: "shots/e2e-forge-branch-card.png" })

const branches = git(["branch", "--format=%(refname:short)"], ORIGIN)
if (/kiln\//.test(branches)) ok(`work branch really reached the remote (${branches.trim().split("\n").join(", ")})`)
else bad("work branch reached the remote", `remote has: ${branches}`)
if (/(^|\n)main($|\n)/.test(branches)) ok("the base branch still exists and was not written to")

const headMain = git(["rev-parse", "main"], ORIGIN).trim()
const seedHead = git(["rev-parse", "main"], join(root, "seed")).trim()
if (headMain === seedHead) ok("base branch is untouched — commits went only to the work branch")
else bad("base branch is untouched", `main moved: ${seedHead} → ${headMain}`)

// ---- 5. a second message continues the same session ----
scenario = "normal"
await composer.fill("Now add a test for that")
await page.getByRole("button", { name: /send/i }).first().click()
await page.waitForTimeout(2500)
const turnCount = await page.locator("[data-msg-id]").count()
if (turnCount >= 4) ok(`a second turn ran in the same chat (${turnCount} messages)`)
else bad("a second turn ran", `only ${turnCount} messages`)

// The sandbox is per chat, not per turn: a second message must not rebuild it.
if (createCount === 1) ok("the second turn reused the warm sandbox (1 create)")
else bad("the second turn reused the warm sandbox", `create called ${createCount}×`)

// ---- 6. the sandbox dies between turns → rebuilt, no re-clone ----
// Destroying the VM takes its published port with it, so the agent stops
// answering too — otherwise the forge would rightly see a live agent and
// reuse it.
const gitDirBefore = join(lastWorkspace, "repo", ".git")
const headBefore = git(["rev-parse", "HEAD"], join(lastWorkspace, "repo")).trim()
sandboxes.clear()
killAgent = true
await composer.fill("Carry on")
await page.getByRole("button", { name: /send/i }).first().click()
await page.waitForTimeout(3000)
if (createCount === 2) ok("a vanished sandbox is rebuilt on the next turn")
else bad("a vanished sandbox is rebuilt", `create called ${createCount}×`)

// The point of a host-side workspace: the rebuild must not re-clone. HEAD
// advances (the turn commits), so the test is that the *previous* HEAD is
// still reachable — a fresh clone off the base branch would have lost it.
const repoAfter = join(lastWorkspace, "repo")
let reused = false
try {
  execFileSync("git", ["merge-base", "--is-ancestor", headBefore, "HEAD"], {
    cwd: repoAfter,
  })
  reused = existsSync(gitDirBefore)
} catch {
  reused = false
}
if (reused) ok("the rebuild reused the existing checkout — no re-clone, history intact")
else
  bad(
    "the rebuild reused the existing checkout",
    `${headBefore} is not an ancestor of HEAD — the workspace was re-cloned`,
  )

// ---- 7. a mid-turn question reaches the phone and the answer unblocks it ----
scenario = "asks"
await composer.fill("Clean the build directory")
await page.getByRole("button", { name: /send/i }).first().click()
await page.waitForSelector("[data-ui=q-card]", { timeout: 25000 })
ok("the agent's permission prompt arrives as a question card")
await page.screenshot({ path: "shots/e2e-forge-question-card.png" })

await page.locator("[data-ui=q-card]").first().click()
await page.waitForTimeout(500)
const sheetText = await page.locator("body").innerText()
if (/rm -rf build/.test(sheetText))
  ok("the prompt names the command it wants to run")
else bad("the prompt names the command", sheetText.slice(0, 200))
await page.screenshot({ path: "shots/e2e-forge-question-sheet.png" })

await page.getByRole("button", { name: "Allow", exact: true }).first().click()
await page.waitForTimeout(400)
const submit = page.getByRole("button", { name: /send|submit|done/i })
if (await submit.count()) await submit.first().click()
await page.waitForFunction(
  () => /Permission granted/.test(document.body.innerText),
  { timeout: 25000 },
)
ok("answering the chip unblocks the agent and the turn continues")

// ---- 8a. the agent's own .claude dir is skipped, not treated as an error ----
scenario = "claudeDir"
await composer.fill("Write a settings file")
await page.getByRole("button", { name: /send/i }).first().click()
await page.waitForTimeout(4500)
const afterClaude = await page.locator("body").innerText()
if (!/Something went wrong/.test(afterClaude))
  ok("Claude Code's own .claude dir is skipped silently, not failed on")
else bad("Claude Code's .claude dir is skipped", afterClaude.slice(-300))

// ---- 8b. the push guard refuses Kiln state that no ignore rule covers ----
scenario = "leak"
await composer.fill("Now do something else")
await page.getByRole("button", { name: /send/i }).first().click()
await page.waitForTimeout(4500)
const afterLeak = await page.locator("body").innerText()
if (/Refusing to (commit|push)/.test(afterLeak))
  ok("the push guard refuses a diff carrying Kiln's own state")
else bad("the push guard refuses Kiln state", afterLeak.slice(-400))

// ---- 9. Kiln's own state never reaches a commit ----
const wsDirs = readFileSync
const repoPath = join(lastWorkspace, "repo")
const tracked = git(["ls-files"], repoPath)
if (!/\.kiln|\.claude/.test(tracked))
  ok("no Kiln or agent state is tracked in the repository")
else bad("no Kiln state is tracked", `git ls-files: ${tracked}`)

const excl = readFileSync(join(repoPath, ".git", "info", "exclude"), "utf8")
if (/\.claude/.test(excl)) ok(".git/info/exclude covers the agent's project dir")
else bad(".git/info/exclude covers the agent's project dir", excl)

console.log(`\n${fail === 0 ? "E2E-FORGE PASSED" : "E2E-FORGE FAILED"} — ${pass} passed, ${fail} failed`)
if (pageErrors.length) console.log(`page errors: ${JSON.stringify(pageErrors)}`)
await browser.close()
cleanup()
process.exit(fail === 0 ? 0 : 1)
