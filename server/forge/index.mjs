/**
 * Kiln forge — runs coding turns in an sbx microVM.
 *
 * The phone POSTs a turn to /api/forge/jobs. This process makes sure the
 * chat's workspace exists on the encrypted mount and is cloned, that a
 * sandbox is running on it, and that kiln-agent (the resident Claude Code
 * session inside the VM) is healthy — then hands it the turn and relays its
 * event stream into a seq-numbered journal. Clients replay that journal over
 * SSE exactly as they do for the cloud runner, so "watch it live" and "catch
 * up after a relaunch" are the same code path.
 *
 * How this differs from server/cloud.mjs, deliberately:
 *   - It keeps per-chat state (sandbox name, agent port) beyond one job, and
 *     writes to disk. It has to: a git checkout is a filesystem. That state is
 *     never load-bearing — losing it costs a sandbox rebuild, nothing more.
 *   - The workspace lives on an encrypted mount the operator provides. The
 *     forge refuses to start without one being configured, because the whole
 *     at-rest story depends on it.
 *
 * Journal entries are `TurnEvent` from src/lib/types.ts — change them
 * together, as cloud.mjs does.
 *
 * Zero dependencies; Node 20+. Env:
 *   PORT                  listen port (default 8091)
 *   KILN_WORKSPACE_ROOT   required; the encrypted mount holding workspaces
 *   KILN_AGENT_HOST       host the published agent port appears on (127.0.0.1)
 *   KILN_ALLOW_PLAIN_FS   set to 1 to run without an encrypted mount (tests)
 */
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { driver, SbxUnavailable } from "./sandbox.mjs"
import { mapSdkMessage, mapResultSummary, permissionAsk, isAllow } from "./events.mjs"
import { ensureClone, commitAndPush, changedPaths, shred, repoDir } from "./git.mjs"

const PORT = Number(process.env.PORT ?? 8091)
const WORKSPACE_ROOT = process.env.KILN_WORKSPACE_ROOT ?? ""
const AGENT_HOST = process.env.KILN_AGENT_HOST ?? "127.0.0.1"
/** the port kiln-agent listens on *inside* the VM */
const AGENT_PORT = Number(process.env.KILN_AGENT_PORT ?? 8790)

const MAX_BODY_BYTES = 64 * 1024 * 1024
const MAX_JOURNAL_CHARS = 32_000_000
const DONE_TTL_MS = 24 * 60 * 60 * 1000
const RUN_CAP_MS = 45 * 60 * 1000
const MAX_RUNNING = 8
const MAX_JOBS = 256
const FLUSH_MS = 150

if (!WORKSPACE_ROOT) {
  console.error(
    "[kiln-forge] KILN_WORKSPACE_ROOT is not set. It must point at an encrypted\n" +
      "            mount — repositories and full session transcripts are written\n" +
      "            there. See deploy/encrypted-workspace.md.",
  )
  process.exit(1)
}

/** jobs by id */
const jobs = new Map()
/** per-chat sandbox state, keyed by chat id. Never load-bearing. */
const chats = new Map()

const wsPath = (chatId) => join(WORKSPACE_ROOT, chatId)

/* ---------- journal (mirrors server/cloud.mjs) ---------- */

function makeJob(cfg) {
  const job = {
    id: randomBytes(18).toString("base64url"),
    createdAt: Date.now(),
    finishedAt: 0,
    status: "running",
    entries: [],
    journalChars: 0,
    pending: { t: null, x: "" },
    flushTimer: null,
    waiters: new Set(),
    abort: new AbortController(),
    capTimer: null,
    /** outstanding ask → resolver, so /reply can unblock the agent */
    asks: new Map(),
    cfg,
  }
  job.capTimer = setTimeout(() => {
    job.abort.abort(new Error("Coding turn hit the 45-minute limit"))
  }, RUN_CAP_MS)
  jobs.set(job.id, job)
  return job
}

function pushEntry(job, entry) {
  entry.seq = job.entries.length
  job.entries.push(entry)
  job.journalChars += JSON.stringify(entry).length
  if (job.journalChars > MAX_JOURNAL_CHARS && job.status === "running")
    job.abort.abort(new Error("Reply exceeded the forge's 32 MB cap"))
  const frame = `data: ${JSON.stringify(entry)}\n\n`
  for (const res of job.waiters) if (!res.destroyed) res.write(frame)
}

function flushPending(job) {
  clearTimeout(job.flushTimer)
  job.flushTimer = null
  if (job.pending.t && job.pending.x) {
    const { t, x } = job.pending
    job.pending = { t: null, x: "" }
    pushEntry(job, { t, x })
  } else {
    job.pending = { t: null, x: "" }
  }
}

function emitDelta(job, t, x) {
  if (!x) return
  if (job.pending.t && job.pending.t !== t) flushPending(job)
  job.pending.t = t
  job.pending.x += x
  if (!job.flushTimer) job.flushTimer = setTimeout(() => flushPending(job), FLUSH_MS)
}

function emit(job, entry) {
  flushPending(job)
  pushEntry(job, entry)
}

function finishJob(job, final) {
  if (job.status !== "running") return
  emit(job, final)
  job.status = final.status
  job.finishedAt = Date.now()
  job.cfg = null // secrets go now; the journal stays until collected
  for (const resolve of job.asks.values()) resolve(null)
  job.asks.clear()
  clearTimeout(job.capTimer)
  clearTimeout(job.flushTimer)
  for (const res of job.waiters) res.end()
  job.waiters.clear()
}

/* ---------- kiln-agent client ---------- */

async function agentFetch(state, path, init = {}) {
  const res = await fetch(`http://${AGENT_HOST}:${state.hostPort}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.agentToken}`,
      ...(init.headers ?? {}),
    },
  })
  return res
}

async function agentHealthy(state) {
  if (!state?.hostPort) return false
  try {
    const res = await agentFetch(state, "/health", {
      signal: AbortSignal.timeout(4000),
    })
    return res.ok
  } catch {
    return false
  }
}

/* ---------- sandbox lifecycle ---------- */

/**
 * Bring the chat's sandbox and agent up, reusing whatever survives.
 *
 * Because the workspace is a host directory, a vanished microVM costs a
 * rebuild and nothing else: no re-clone, no npm install, no transcript
 * restore. The agent comes back with --resume and the conversation with it.
 */
async function ensureSandbox(job, chatId, repo, secrets) {
  const ws = wsPath(chatId)
  let state = chats.get(chatId)

  if (state && (await agentHealthy(state))) return state

  emit(job, {
    t: "tool",
    id: "sandbox",
    name: "workspace",
    args: { repo: `${repo.owner}/${repo.name}`, branch: repo.baseBranch },
  })

  await mkdir(ws, { recursive: true })
  const { cloned } = await ensureClone({
    ws,
    owner: repo.owner,
    name: repo.name,
    baseBranch: repo.baseBranch,
    workBranch: repo.workBranch,
    token: secrets.githubToken,
  })

  // A sandbox may still exist from a previous turn even when the agent died.
  const existing = state?.name ? await driver.get(state.name).catch(() => null) : null
  let name = existing?.name ?? state?.name
  const agentToken = state?.agentToken ?? randomBytes(24).toString("base64url")

  if (!existing) {
    name = `kiln-${chatId.slice(0, 8)}-${randomBytes(3).toString("hex")}`
    await driver.create({
      name,
      workspace: ws,
      // Only the bootstrap token goes in env: create-time env is likely
      // persisted to daemon metadata on host disk, and the GitHub PAT and
      // provider key must not be. Those go over the agent's authed port.
      env: {
        KILN_AGENT_TOKEN: agentToken,
        KILN_WS: ws,
        HOME: join(ws, ".kiln", "home"),
        CLAUDE_CONFIG_DIR: join(ws, ".kiln", "claude"),
        HISTFILE: "/dev/null",
      },
      ports: [String(AGENT_PORT)],
    })
  }

  const hostPort = await driver.publishPort(name, AGENT_PORT)
  state = { name, hostPort, agentToken, ws, cloned }
  chats.set(chatId, state)

  // Give the agent a moment to bind; the sandbox reports ready before the
  // process inside it necessarily is.
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await agentHealthy(state)) return state
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error("kiln-agent did not come up inside the sandbox")
}

/* ---------- the turn ---------- */

async function runForgeJob(job) {
  const { chatId, repo, prompt, attachments, model, provider, secrets, resumeSessionId, forkSession } =
    job.cfg
  try {
    const state = await ensureSandbox(job, chatId, repo, secrets)

    const res = await agentFetch(state, "/turn", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        attachments,
        model,
        provider,
        resume: resumeSessionId,
        forkSession,
        // Secrets travel here, per turn, over the authenticated loopback port
        // — never through sbx create-time env.
        secrets,
      }),
      signal: job.abort.signal,
    })
    if (!res.ok) throw new Error(`kiln-agent refused the turn: HTTP ${res.status}`)
    const { runId } = await res.json()

    await relayAgentStream(job, state, runId)

    // Commit and push whatever the turn produced.
    if (job.status === "running") {
      // Deliberately *not* emitted as a tool step. consumeTurn treats a tool
      // event as the start of a new round and clears the prose before it, so a
      // step here would erase the agent's closing summary — the most useful
      // part of the reply. The file count travels on the branch event instead,
      // which is also where a reader would look for it.
      void (await changedPaths(state.ws))
      const result = await commitAndPush({
        ws: state.ws,
        workBranch: repo.workBranch,
        baseBranch: repo.baseBranch,
        message: prompt.slice(0, 72).replace(/\s+/g, " ").trim() || "Kiln coding turn",
        token: secrets.githubToken,
      })
      if (result.pushed)
        emit(job, {
          t: "branch",
          name: repo.workBranch,
          url: `https://github.com/${repo.owner}/${repo.name}/compare/${encodeURIComponent(repo.baseBranch)}...${encodeURIComponent(repo.workBranch)}?expand=1`,
          commits: result.commits,
          filesChanged: result.files,
        })
    }

    finishJob(job, { t: "final", status: "done" })
  } catch (e) {
    if (job.abort.signal.aborted && job.status === "running") {
      finishJob(job, { t: "final", status: "stopped" })
      return
    }
    const msg = e instanceof SbxUnavailable ? e.message : (e?.message ?? String(e))
    finishJob(job, { t: "final", status: "error", error: msg })
  }
}

/**
 * Relay the agent's SSE into our journal, translating harness messages into
 * TurnEvents and turning permission prompts into question chips.
 */
async function relayAgentStream(job, state, runId) {
  const res = await agentFetch(state, `/events?run=${encodeURIComponent(runId)}&from=0`, {
    headers: { accept: "text/event-stream" },
    signal: job.abort.signal,
  })
  if (!res.ok || !res.body) throw new Error(`kiln-agent stream: HTTP ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith("data:")) continue
      let msg
      try {
        msg = JSON.parse(t.slice(5))
      } catch {
        continue
      }
      if (msg.kilnEnd) return
      await handleAgentMessage(job, state, msg)
    }
  }
}

async function handleAgentMessage(job, state, msg) {
  // A permission prompt: surface it as chips and block until the phone answers.
  if (msg.type === "permission_request") {
    const ask = permissionAsk(msg.requestId, msg.toolName, msg.input)
    emit(job, ask)
    const answer = await new Promise((resolve) => {
      job.asks.set(msg.requestId, resolve)
      job.abort.signal.addEventListener("abort", () => resolve(null), { once: true })
    })
    job.asks.delete(msg.requestId)
    await agentFetch(state, "/reply", {
      method: "POST",
      body: JSON.stringify({
        requestId: msg.requestId,
        decision: isAllow(answer) ? "allow" : "deny",
      }),
    }).catch(() => {})
    return
  }

  if (msg.type === "summary") {
    for (const e of mapResultSummary(msg)) emit(job, e)
    return
  }

  for (const e of mapSdkMessage(msg)) {
    // Text and reasoning batch; everything else keeps strict ordering.
    if (e.t === "text" || e.t === "reasoning") emitDelta(job, e.t, e.x)
    else emit(job, e)
  }
}

/* ---------- HTTP ---------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  res.end(JSON.stringify(obj))
}

function validateJobRequest(b) {
  if (typeof b !== "object" || b === null) return "not an object"
  if (typeof b.chatId !== "string" || !b.chatId) return "missing chatId"
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(b.chatId)) return "bad chatId"
  const r = b.repo
  if (!r || typeof r !== "object") return "missing repo"
  for (const f of ["owner", "name", "baseBranch", "workBranch"])
    if (typeof r[f] !== "string" || !r[f]) return `missing repo.${f}`
  if (typeof b.prompt !== "string" || !b.prompt.trim()) return "missing prompt"
  if (!b.secrets?.githubToken) return "missing GitHub token"
  return null
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = url.pathname

    if (req.method === "GET" && path === "/api/forge/health") {
      const sbx = await driver.health()
      return sendJson(res, 200, { ok: sbx.ok, sbx, jobs: jobs.size })
    }

    if (req.method === "POST" && path === "/api/forge/jobs") {
      const running = [...jobs.values()].filter((j) => !j.finishedAt).length
      if (running >= MAX_RUNNING)
        return sendJson(res, 429, {
          error: `The forge is already running ${running} coding turns — try again in a moment`,
        })
      let body
      try {
        body = JSON.parse((await readBody(req)).toString("utf8"))
      } catch (e) {
        return sendJson(res, 400, {
          error: /large/i.test(e?.message ?? "")
            ? "Request too large for the forge (64 MB cap)"
            : "Invalid JSON",
        })
      }
      const invalid = validateJobRequest(body)
      if (invalid) return sendJson(res, 400, { error: `Bad request: ${invalid}` })
      const job = makeJob({
        chatId: body.chatId,
        repo: body.repo,
        prompt: body.prompt,
        attachments: Array.isArray(body.attachments) ? body.attachments : [],
        model: typeof body.model === "string" ? body.model : "",
        provider: body.provider === "ollama" ? "ollama" : "openrouter",
        resumeSessionId:
          typeof body.resumeSessionId === "string" ? body.resumeSessionId : "",
        forkSession: !!body.forkSession,
        secrets: {
          githubToken: String(body.secrets?.githubToken ?? ""),
          providerKey: String(body.secrets?.providerKey ?? ""),
          ollamaBaseUrl: String(body.secrets?.ollamaBaseUrl ?? ""),
        },
      })
      void runForgeJob(job)
      return sendJson(res, 201, { id: job.id })
    }

    const m =
      /^\/api\/forge\/jobs\/([A-Za-z0-9_-]{10,64})(\/events|\/stop|\/reply)?$/.exec(path)
    if (m) {
      const job = jobs.get(m[1])

      if (req.method === "GET" && m[2] === "/events") {
        if (!job) return sendJson(res, 404, { error: "No such job" })
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
          connection: "keep-alive",
        })
        res.write(": kiln-forge\n\n")
        const from = Math.max(0, parseInt(url.searchParams.get("from") ?? "0") || 0)
        for (let i = from; i < job.entries.length; i++)
          res.write(`data: ${JSON.stringify(job.entries[i])}\n\n`)
        if (job.status !== "running") return res.end()
        job.waiters.add(res)
        res.on("error", () => {})
        const heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(": hb\n\n")
        }, 15_000)
        req.on("close", () => {
          clearInterval(heartbeat)
          job.waiters.delete(res)
        })
        res.on("close", () => clearInterval(heartbeat))
        return
      }

      if (req.method === "POST" && m[2] === "/stop") {
        if (job && job.status === "running") job.abort.abort("stopped")
        return sendJson(res, 200, { ok: true })
      }

      if (req.method === "POST" && m[2] === "/reply") {
        if (!job) return sendJson(res, 404, { error: "No such job" })
        let body
        try {
          body = JSON.parse((await readBody(req)).toString("utf8"))
        } catch {
          return sendJson(res, 400, { error: "Invalid JSON" })
        }
        const resolve = job.asks.get(body.requestId)
        if (!resolve) return sendJson(res, 409, { error: "No such pending question" })
        resolve(String(body.answer ?? ""))
        return sendJson(res, 200, { ok: true })
      }

      if (req.method === "DELETE" && !m[2]) {
        if (job) {
          if (job.status === "running") job.abort.abort("stopped")
          jobs.delete(job.id)
        }
        res.writeHead(204)
        return res.end()
      }
    }

    const w = /^\/api\/forge\/workspaces\/([A-Za-z0-9_-]{1,64})$/.exec(path)
    if (w && req.method === "DELETE") {
      const chatId = w[1]
      const state = chats.get(chatId)
      if (state?.name) await driver.remove(state.name).catch(() => {})
      chats.delete(chatId)
      await shred(wsPath(chatId)).catch(() => {})
      res.writeHead(204)
      return res.end()
    }

    sendJson(res, 404, { error: "Not found" })
  } catch (e) {
    console.error(`[kiln-forge] request error: ${e instanceof Error ? e.message : e}`)
    if (!res.headersSent) sendJson(res, 500, { error: "Internal error" })
    else res.end()
  }
})

/** Drop collected-or-not journals, as the cloud runner does. */
setInterval(() => {
  const now = Date.now()
  for (const [id, job] of jobs)
    if (job.finishedAt && now - job.finishedAt > DONE_TTL_MS) jobs.delete(id)
  if (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()]
      .filter((j) => j.finishedAt)
      .sort((a, b) => a.finishedAt - b.finishedAt)
    for (const j of oldest.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.id)
  }
}, 60_000).unref()

server.listen(PORT, () => {
  console.log(
    `[kiln-forge] coding runner listening on :${PORT} — workspaces at ${WORKSPACE_ROOT}`,
  )
  if (!process.env.KILN_ALLOW_PLAIN_FS)
    console.log(
      "[kiln-forge] reminder: KILN_WORKSPACE_ROOT must be an encrypted mount " +
        "(see deploy/encrypted-workspace.md) — repositories and full session " +
        "transcripts are written there.",
    )
})
