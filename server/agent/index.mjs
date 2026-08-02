/**
 * kiln-agent — the resident Claude Code session inside an sbx microVM.
 *
 * This is the only thing Kiln ships into the sandbox. It holds **one**
 * `query()` open for the life of the chat, with the prompt fed from an async
 * iterable, so every message continues the same session with no `resume` and
 * no re-reading of files the agent already read. `resume` is the crash path,
 * not the normal path.
 *
 * Why resident rather than one exec per turn: only a live process can call
 * back. That is what makes `canUseTool` possible, and a permission prompt on
 * the phone is the difference between an agent that asks and one that guesses.
 *
 * Nothing here connects outward. The forge reaches this process on a port
 * sbx publishes to 127.0.0.1 on the host, and every request carries a bearer
 * token that only exists for this sandbox.
 *
 * Env (set by the forge at sandbox creation — note the *absence* of any
 * credential; those arrive per turn on /turn, so they never reach the sbx
 * daemon's on-disk metadata):
 *   KILN_AGENT_TOKEN  bearer token every request must present
 *   KILN_WS           the workspace root; cwd is $KILN_WS/repo
 *   PORT              listen port (default 8790)
 */
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { join } from "node:path"

const PORT = Number(process.env.PORT ?? 8790)
const TOKEN = process.env.KILN_AGENT_TOKEN ?? ""
const WS = process.env.KILN_WS ?? "/workspace"
const CWD = join(WS, "repo")

/** Loaded lazily so the process can answer /health even if the SDK is absent. */
let queryFn = null
async function loadSdk() {
  if (queryFn) return queryFn
  const mod = await import("@anthropic-ai/claude-agent-sdk")
  queryFn = mod.query
  return queryFn
}

/**
 * The open session. `inbox` is the async iterable feeding `query()`; pushing
 * to it is how a new user message continues the same conversation.
 */
const session = {
  started: false,
  sessionId: "",
  /** @type {((v: unknown) => void) | null} */
  wake: null,
  queue: [],
  handle: null,
  /** current run's journal, so the forge can replay after a reconnect */
  runs: new Map(),
}

/** Pending permission prompts, keyed by requestId. */
const pending = new Map()

function makeInbox() {
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (session.queue.length) {
          yield session.queue.shift()
          continue
        }
        await new Promise((resolve) => {
          session.wake = resolve
        })
      }
    },
  }
}

function pushUserMessage(text, attachments = []) {
  // Attachment paths are passed by reference rather than inlined: the files
  // are already in the workspace, and pasting a log into the prompt would
  // burn context the agent could spend on the repo.
  const note = attachments.length
    ? `\n\nAttached files (read them if relevant):\n${attachments
        .map((a) => `- ${join(WS, ".kiln", "uploads", a.name)}`)
        .join("\n")}`
    : ""
  session.queue.push({
    type: "user",
    content: [{ type: "text", text: text + note }],
  })
  session.wake?.()
  session.wake = null
}

function journal(run, msg) {
  run.entries.push(msg)
  const frame = `data: ${JSON.stringify(msg)}\n\n`
  for (const res of run.waiters) if (!res.destroyed) res.write(frame)
}

function endRun(run) {
  run.done = true
  const frame = `data: ${JSON.stringify({ kilnEnd: true })}\n\n`
  for (const res of run.waiters) {
    if (!res.destroyed) res.write(frame)
    res.end()
  }
  run.waiters.clear()
}

/**
 * Permission callback. Emits a request the forge turns into question chips,
 * then blocks this tool call until an answer comes back through /reply.
 */
function makeCanUseTool(run) {
  return async (toolName, input) => {
    const requestId = randomBytes(9).toString("base64url")
    journal(run, { type: "permission_request", requestId, toolName, input })
    const decision = await new Promise((resolve) => {
      pending.set(requestId, resolve)
      // If the turn is torn down, default to refusing: an unanswered prompt
      // must never read as consent.
      run.onAbort.push(() => resolve("deny"))
    })
    pending.delete(requestId)
    return decision === "allow"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "The user declined this from their phone." }
  }
}

/** Provider env, mirroring the table in the plan. */
function providerEnv({ provider, providerKey, ollamaBaseUrl, model }) {
  const env = { ...process.env, HOME: join(WS, ".kiln", "home") }
  if (provider === "ollama") {
    env.ANTHROPIC_BASE_URL = ollamaBaseUrl || "https://ollama.com"
    env.ANTHROPIC_AUTH_TOKEN = providerKey || "ollama"
    env.ANTHROPIC_API_KEY = ""
  } else {
    env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api"
    env.ANTHROPIC_AUTH_TOKEN = providerKey
    // Must be explicitly empty, not absent: a stray ANTHROPIC_API_KEY in the
    // image would silently win and bill the wrong account.
    env.ANTHROPIC_API_KEY = ""
  }
  if (model) env.ANTHROPIC_MODEL = model
  if (process.env.KILN_GITHUB_TOKEN) env.GITHUB_TOKEN = process.env.KILN_GITHUB_TOKEN
  return env
}

async function startTurn(body) {
  const runId = randomBytes(9).toString("base64url")
  const run = { id: runId, entries: [], waiters: new Set(), done: false, onAbort: [] }
  session.runs.set(runId, run)

  // Secrets arrive per turn and live only in this process's memory.
  if (body.secrets?.githubToken) process.env.KILN_GITHUB_TOKEN = body.secrets.githubToken

  if (!session.started) {
    const query = await loadSdk()
    session.started = true
    session.handle = query({
      prompt: makeInbox(),
      options: {
        cwd: CWD,
        model: body.model || undefined,
        includePartialMessages: false,
        permissionMode: "default",
        canUseTool: makeCanUseTool(run),
        env: providerEnv({
          provider: body.provider,
          providerKey: body.secrets?.providerKey,
          ollamaBaseUrl: body.secrets?.ollamaBaseUrl,
          model: body.model,
        }),
        ...(body.resume ? { resume: body.resume } : {}),
        ...(body.forkSession ? { forkSession: true } : {}),
      },
    })
    void pump(run)
  } else {
    // Same open session: the current run just becomes the one being journalled.
    session.current = run
  }

  pushUserMessage(body.prompt, body.attachments)
  session.current = run
  return runId
}

/** Drain the harness's message stream into whichever run is current. */
async function pump(firstRun) {
  session.current = firstRun
  try {
    for await (const msg of session.handle) {
      const run = session.current ?? firstRun
      if (msg.type === "system" && msg.data?.session_id)
        session.sessionId = msg.data.session_id
      journal(run, msg)
      // A result message with no tool_use_id is the end-of-turn summary.
      if (msg.type === "result" && !msg.tool_use_id) {
        journal(run, { type: "summary", ...msg })
        endRun(run)
      }
    }
  } catch (e) {
    const run = session.current ?? firstRun
    journal(run, { type: "error", error: e?.message ?? String(e) })
    endRun(run)
  }
}

/* ---------- HTTP ---------- */

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")

  // Every route but /health is authenticated. This process can run arbitrary
  // commands; an unauthenticated port would be a remote shell.
  if (url.pathname !== "/health") {
    const auth = req.headers.authorization ?? ""
    if (!TOKEN || auth !== `Bearer ${TOKEN}`)
      return sendJson(res, 401, { error: "Unauthorised" })
  }

  try {
    if (req.method === "GET" && url.pathname === "/health")
      return sendJson(res, 200, { ok: true, sessionId: session.sessionId })

    if (req.method === "POST" && url.pathname === "/turn") {
      const body = JSON.parse(await readBody(req))
      if (typeof body.prompt !== "string" || !body.prompt.trim())
        return sendJson(res, 400, { error: "missing prompt" })
      const runId = await startTurn(body)
      return sendJson(res, 201, { runId })
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const run = session.runs.get(url.searchParams.get("run") ?? "")
      if (!run) return sendJson(res, 404, { error: "No such run" })
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
        connection: "keep-alive",
      })
      res.write(": kiln-agent\n\n")
      const from = Math.max(0, parseInt(url.searchParams.get("from") ?? "0") || 0)
      for (let i = from; i < run.entries.length; i++)
        res.write(`data: ${JSON.stringify(run.entries[i])}\n\n`)
      if (run.done) {
        res.write(`data: ${JSON.stringify({ kilnEnd: true })}\n\n`)
        return res.end()
      }
      run.waiters.add(res)
      res.on("error", () => {})
      req.on("close", () => run.waiters.delete(res))
      return
    }

    if (req.method === "POST" && url.pathname === "/reply") {
      const body = JSON.parse(await readBody(req))
      const resolve = pending.get(body.requestId)
      if (!resolve) return sendJson(res, 409, { error: "No such pending request" })
      resolve(body.decision === "allow" ? "allow" : "deny")
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === "POST" && url.pathname === "/interrupt") {
      // Graceful: the session stays resumable, which killing the process
      // would not be.
      await session.handle?.interrupt?.().catch(() => {})
      for (const run of session.runs.values())
        if (!run.done) for (const cb of run.onAbort) cb()
      return sendJson(res, 200, { ok: true })
    }

    sendJson(res, 404, { error: "Not found" })
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e?.message ?? "Internal error" })
    else res.end()
  }
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[kiln-agent] listening on :${PORT}, cwd ${CWD}`)
})
