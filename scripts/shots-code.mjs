// Screenshots of the coding feature, for the README. Follows
// scripts/screenshots.mjs's conventions (393x852, DPR 2, CHROMIUM_PATH) and
// reuses e2e-forge.mjs's fixtures — a mock sbx daemon on a real Unix socket,
// a mock kiln-agent and a local git remote — so these are the real UI driving
// the real forge, with only the microVM faked.
//
// Needs `npm run preview` on :4173.
// Usage: node scripts/shots-code.mjs [outDir]
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
const OUT = process.argv[2] ?? "docs/screenshots"
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
})
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark",
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
})
const page = await ctx.newPage()

await page.addInitScript(() => {
  if (!localStorage.getItem("amber-settings"))
    localStorage.setItem(
      "amber-settings",
      JSON.stringify({
        version: 2,
        state: {
          githubToken: "github_pat_demo",
          openrouterKey: "sk-or-demo",
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
      body: JSON.stringify(
        [
          ["demo", "the demo repo", "2026-08-01T00:00:00Z"],
          ["kiln", "a local-first mobile AI chat PWA", "2026-07-30T00:00:00Z"],
          ["sbx-sdk", "clients for the sbx daemon API", "2026-07-22T00:00:00Z"],
          ["dotfiles", null, "2026-06-11T00:00:00Z"],
        ].map(([name, description, pushed]) => ({
          name,
          full_name: `acct/${name}`,
          owner: { login: "acct" },
          default_branch: "main",
          private: name === "dotfiles",
          description,
          pushed_at: pushed,
        })),
      ),
    })
  if (/\/branches$/.test(u.pathname))
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { name: "main", protected: true },
        { name: "develop", protected: false },
        { name: "feature/streaming", protected: false },
      ]),
    })
  return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
})

const shot = async (name, waitMs = 700) => {
  await page.waitForTimeout(waitMs)
  await page.screenshot({ path: `${OUT}/code-${name}.png` })
  console.log(`  ${OUT}/code-${name}.png`)
}

console.log("capturing:")
await page.goto(BASE)
await page.waitForTimeout(900)

// Settings row
await page.goto(`${BASE}/settings`)
await page.waitForTimeout(600)
await page.getByText("GitHub token (coding)").scrollIntoViewIfNeeded()
await shot("settings-token", 500)

// Repo picker
await page.goto(BASE)
await page.waitForTimeout(900)
const menu = page.getByRole("button", { name: "Open menu" })
if (await menu.count()) await menu.first().click()
await page.waitForTimeout(350)
await page.getByRole("button", { name: "New code chat" }).first().click()
await page.getByPlaceholder("Search repositories…").waitFor({ timeout: 15000 })
await shot("repo-picker")

// Branch picker
await page.locator("[data-slot=command-item]").filter({ hasText: "demo" }).first().click()
await page.getByPlaceholder("Search branches…").waitFor({ timeout: 15000 })
await shot("branch-picker")

await page.locator("[data-slot=command-item]").filter({ hasText: "main" }).first().click()
await page.waitForTimeout(900)

// A turn mid-flight
const composer = page.locator("textarea").first()
await composer.fill("Add a streaming section to the README")
await page.getByRole("button", { name: /send/i }).first().click()
await shot("chat-streaming", 900)

// The pushed branch card
await page.waitForSelector("[data-ui=branch-card]", { timeout: 25000 })
await shot("branch-card", 600)

// A permission prompt as chips
scenario = "asks"
await composer.fill("Clean the build directory")
await page.getByRole("button", { name: /send/i }).first().click()
await page.waitForSelector("[data-ui=q-card]", { timeout: 25000 })
await shot("question-card", 600)
await page.locator("[data-ui=q-card]").first().click()
await shot("question-sheet", 700)

await browser.close()
cleanup()
console.log("done")
